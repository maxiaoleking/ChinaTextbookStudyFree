#!/usr/bin/env python3
"""Exercise the real exceptional formats and idempotent S3 metadata correction."""
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/deploy'))
from media_types import inspect_overrides, load_media_overrides, media_content_type


class FakeS3:
    def __init__(self):
        self.objects = {
            'audio/test.opus': {'ContentType':'audio/ogg','ContentLength':42,'ETag':'"etag"',
                                'CacheControl':'public,max-age=31536000,immutable','Metadata':{'source':'generated'}},
            'story-images/test.jpg': {'ContentType':'image/png','ContentLength':75,'ETag':'"image"','Metadata':{}},
        }
        self.copies = []

    def head_object(self, Bucket, Key):
        assert Bucket == 'test-bucket'
        return dict(self.objects[Key])

    def copy_object(self, **kwargs):
        assert kwargs['CopySource'] == {'Bucket':'test-bucket','Key':kwargs['Key']}
        assert kwargs['CopySourceIfMatch'] == self.objects[kwargs['Key']]['ETag']
        assert kwargs['MetadataDirective'] == 'REPLACE'
        self.copies.append(kwargs)
        self.objects[kwargs['Key']]['ContentType'] = kwargs['ContentType']


overrides = {'audio/test.opus':'audio/mpeg','story-images/test.jpg':'image/png'}
client = FakeS3()
assert len(inspect_overrides(client,'test-bucket',overrides)['mismatches']) == 1
first = inspect_overrides(client,'test-bucket',overrides,repair=True)
assert first['corrected'] == 1 and not first['mismatches']
assert client.copies[0]['CacheControl'] == 'public,max-age=31536000,immutable'
assert client.copies[0]['Metadata'] == {'source':'generated'}
second = inspect_overrides(client,'test-bucket',overrides,repair=True)
assert second['corrected'] == 0 and len(client.copies) == 1
real_mp3 = ROOT/'apps/web/public/audio/00/009d5c5ba39e5e589ed9bd988f058a2c79215722.opus'
real_png = ROOT/'apps/web/public/story-images/english-g3down/english-g3down-s1.jpg'
assert media_content_type(real_mp3) == 'audio/mpeg'
assert media_content_type(real_png) == 'image/png'
with tempfile.TemporaryDirectory() as folder:
    site = Path(folder)/'site'
    (site/'audio').mkdir(parents=True)
    (site/'audio/sample.opus').write_bytes(b'OggS'+b'\0'*20)
    assert load_media_overrides(site) == {}
    (site.parent/'site-media-types.json').write_text(json.dumps({'version':1,'overrides':{'../wrong':'audio/ogg'}}))
    try:
        load_media_overrides(site)
        raise AssertionError('unsafe path was accepted')
    except ValueError:
        pass
print('PASS: actual MP3/PNG headers, preserving cache/metadata, correcting only wrong types, idempotence, and manifest path validation.')
