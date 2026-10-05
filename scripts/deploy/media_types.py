"""Identify public media by bytes and correct only exceptional S3 MIME metadata."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path

MEDIA_FOLDERS = {'audio', 'story-images', 'textbook-pages'}


def media_content_type(path):
    with path.open('rb') as stream:
        header = stream.read(24)
    if header.startswith(b'OggS'):
        return 'audio/ogg'
    if header.startswith(b'\xff\xd8'):
        return 'image/jpeg'
    if header.startswith(b'ID3') or (len(header) >= 2 and header[0] == 0xff and header[1] & 0xe0 == 0xe0):
        return 'audio/mpeg'
    if header.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if header.startswith((b'GIF87a', b'GIF89a')):
        return 'image/gif'
    if header.startswith(b'RIFF') and header[8:12] == b'WEBP':
        return 'image/webp'
    if header.startswith(b'RIFF') and header[8:12] == b'WAVE':
        return 'audio/wav'
    raise ValueError(f'Unknown media container: {path}')


def expected_extension_type(path):
    return {'.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
            '.gif': 'image/gif', '.wav': 'audio/wav'}.get(path.suffix.lower())


def manifest_path(site):
    return site.parent/f'{site.name}-media-types.json'


def write_media_manifest(site, overrides):
    manifest_path(site).write_text(json.dumps({'version': 1, 'overrides': overrides}, indent=2)+'\n')


def load_media_overrides(site):
    manifest = manifest_path(site)
    if manifest.is_file():
        data = json.loads(manifest.read_text())
        if data.get('version') != 1:
            raise ValueError(f'Unsupported media manifest: {manifest}')
        overrides = data['overrides']
        for key, content_type in overrides.items():
            relative = Path(key)
            if relative.parts[0] not in MEDIA_FOLDERS or '..' in relative.parts or relative.is_absolute():
                raise ValueError(f'Invalid media key: {key}')
            if media_content_type(site/relative) != content_type:
                raise ValueError(f'Media bytes changed after staging: {key}')
        return overrides
    # Older snapshots predate the manifest. Inspect only public media headers.
    overrides = {}
    for folder in MEDIA_FOLDERS:
        for file in (site/folder).rglob('*'):
            if file.is_file() and file.suffix.lower() != '.json':
                content_type = media_content_type(file)
                if content_type != expected_extension_type(file):
                    overrides[file.relative_to(site).as_posix()] = content_type
    return overrides


def s3_client(profile='default', region='ap-northeast-1'):
    # botocore is already provided by AWS CLI in the deployment environment.
    # Credentials stay in its standard provider chain and are never printed.
    from botocore.config import Config
    from botocore.session import Session
    return Session(profile=profile).create_client('s3', region_name=region,
        config=Config(max_pool_connections=24, retries={'mode': 'standard', 'max_attempts': 3}))


def inspect_overrides(client, bucket, overrides, repair=False):
    def inspect(item):
        key, expected = item
        head = client.head_object(Bucket=bucket, Key=key)
        actual = head.get('ContentType', '').split(';')[0].strip().lower()
        if actual == expected:
            return {'key': key, 'content_type': actual, 'changed': False}
        if not repair:
            return {'key': key, 'expected': expected, 'actual': actual, 'changed': False}
        kwargs = {'Bucket': bucket, 'Key': key, 'CopySource': {'Bucket': bucket, 'Key': key},
                  'CopySourceIfMatch': head['ETag'], 'MetadataDirective': 'REPLACE',
                  'ContentType': expected, 'Metadata': head.get('Metadata', {})}
        for field in ('CacheControl', 'ContentDisposition', 'ContentEncoding', 'ContentLanguage', 'Expires'):
            if field in head:
                kwargs[field] = head[field]
        client.copy_object(**kwargs)
        final = client.head_object(Bucket=bucket, Key=key)
        if final.get('ContentType') != expected or final['ContentLength'] != head['ContentLength']:
            raise ValueError(f'Media metadata correction did not verify: {key}')
        return {'key': key, 'content_type': expected, 'changed': True}
    with ThreadPoolExecutor(max_workers=24) as pool:
        results = list(pool.map(inspect, overrides.items()))
    return {'checked': len(results), 'corrected': sum(item.get('changed', False) for item in results),
            'mismatches': [item for item in results if 'expected' in item]}
