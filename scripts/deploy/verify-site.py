#!/usr/bin/env python3
"""Read-only comparison of the deployed S3 package and public HTTPS smoke checks."""
import hashlib
import argparse
import json
import subprocess
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
from media_types import inspect_overrides, load_media_overrides, media_content_type, s3_client

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--site',type=Path)
args = parser.parse_args()
state = json.loads((ROOT/'deploy-output/aws-state.json').read_text())
site = ROOT/'deploy-output/site-approved'
if not site.exists():
    site = ROOT/'deploy-output/site-final'
if not site.exists():
    site = ROOT/'deploy-output/site'
if args.site:
    site = args.site
report = {'url':state['WebsiteUrl'],'checks':[]}
remote = json.loads(subprocess.check_output([
    'aws','s3api','list-objects-v2','--bucket',state['BucketName'],
    '--region','ap-northeast-1','--query','Contents[].{Key:Key,Size:Size}',
    '--output','json','--no-cli-pager'],text=True))
actual = {x['Key']:x['Size'] for x in remote}
expected = {p.relative_to(site).as_posix():p.stat().st_size for p in site.rglob('*') if p.is_file()}
missing = [key for key in expected if key not in actual]
mismatch = [key for key in expected if key in actual and actual[key]!=expected[key]]
extra = [key for key in actual if key not in expected]
previous_sites = [p for p in (ROOT/'deploy-output').glob('site*') if p.is_dir() and p != site]
retained = [key for key in extra if any((previous/key).is_file() and (previous/key).stat().st_size == actual[key]
                    for previous in previous_sites)]
unexpected = [key for key in extra if key not in retained]
report['inventory'] = {'local_files':len(expected),'remote_files':len(actual),
                       'remote_bytes':sum(actual.values()),'missing':missing,
                       'size_mismatches':mismatch,'retained_previous_assets':retained,
                       'unexpected_objects':unexpected}
assert not missing and not mismatch and not unexpected, report['inventory']
media_overrides = load_media_overrides(site)
report['media_metadata'] = inspect_overrides(s3_client(),state['BucketName'],media_overrides)
assert not report['media_metadata']['mismatches'],report['media_metadata']


def get(path, headers=None, expected_status=200, compare=None):
    url = state['WebsiteUrl']+quote(path,safe='/')
    try:
        response=urlopen(Request(url,headers=headers or {}),timeout=40)
    except HTTPError as error:
        response=error
    with response:
        data=response.read()
        result={'path':path,'status':response.status,'bytes':len(data),
                'content_type':response.headers.get('Content-Type'),
                'content_range':response.headers.get('Content-Range'),
                'cache_control':response.headers.get('Cache-Control')}
        assert response.status==expected_status,result
        if compare:
            assert hashlib.sha256(data).digest()==hashlib.sha256(compare.read_bytes()).digest(),result
            result['matches_local']=True
        assert response.headers.get('x-content-type-options')=='nosniff',result
        report['checks'].append(result)
        return data,result

for path in ['/', '/book/chinese-g3up/', '/book/chinese-g3up',
             '/reading/chinese-g3up/chinese-g3up-p1/',
             '/stories/chinese-g3up/chinese-g3up-s1-v2/',
             '/lesson/g1up/g1up-u1-kp1/', '/profile/', '/review/', '/shop/']:
    get(path)
get('/book/chinese-g3up/index.txt',compare=site/'book/chinese-g3up/index.txt')
get('/data/index.json',compare=site/'data/index.json')
get('/data/books/g3up/lessons/g3up-u1-kp1.json',
    compare=site/'data/books/g3up/lessons/g3up-u1-kp1.json')
for folder in ['audio','story-images','textbook-pages']:
    paths=sorted(p for p in (site/folder).rglob('*') if p.is_file() and p.suffix in {'.opus','.jpg'})
    for file in [paths[0], paths[-1]]:
        get('/'+file.relative_to(site).as_posix(),compare=file)
    if folder=='audio':
        _,result=get('/'+paths[0].relative_to(site).as_posix(),headers={'Range':'bytes=0-31'},expected_status=206)
        assert result['content_type'].startswith(media_content_type(paths[0])),result
        assert result['bytes']==32,result
for content_type in sorted(set(media_overrides.values())):
    key=next(key for key,value in media_overrides.items() if value==content_type)
    _,result=get('/'+key,compare=site/key)
    assert result['content_type'].split(';')[0]==content_type,result
# Check the exact lecture and opening phrase reported by the iPhone user,
# including a ranged response, rather than only legacy media samples.
for key in ['audio/52/52238bfd712374ff6eccc1752fc152b166ef40cc.mp3',
            'audio/cc/ccd353f69f162112ce59aea1b6203fb5823e8edd.mp3']:
    if not (site/key).is_file():
        raise AssertionError(f'Missing iPhone-compatible lecture: {key}')
    _,result=get('/'+key,compare=site/key)
    assert result['content_type'].split(';')[0]=='audio/mpeg',result
    _,result=get('/'+key,headers={'Range':'bytes=0-31'},expected_status=206)
    assert result['content_type'].split(';')[0]=='audio/mpeg' and result['bytes']==32,result
get('/deployment-check-does-not-exist/',expected_status=404)

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None
try:
    build_opener(NoRedirect).open(state['WebsiteUrl'].replace('https:','http:')+'/',timeout=40)
    raise AssertionError('HTTP must redirect to HTTPS')
except HTTPError as error:
    assert error.code in (301,302,307,308),error.code
    assert error.headers['Location'].startswith(state['WebsiteUrl'])
    report['http_redirect']=error.code
try:
    urlopen('https://'+state['BucketName']+'.s3.ap-northeast-1.amazonaws.com/index.html',timeout=40)
    raise AssertionError('S3 origin must remain private')
except HTTPError as error:
    assert error.code==403,error.code
    report['private_s3_status']=error.code
report['passed']=True
(ROOT/'deploy-output/live-verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
