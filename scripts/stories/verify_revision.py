#!/usr/bin/env python3
"""Verify published revisions against reviewed sources and their built media references."""
import argparse
import hashlib
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
from revise import ROOT, STAGE, read, write_json, fingerprint, validate, spoken_texts
from revision_media import AUDIO, audio_path
from run_revision import approved


def verify(require_all=False, decode=False, images=False):
    jobs=read(STAGE/'plan.json')
    errors=[];rows=[];audios=set(); references=0
    built={j['bookId']:read(ROOT/'apps/web/public/data/books'/j['bookId']/'stories.json')['stories'] for j in jobs}
    source={j['bookId']:read(ROOT/'data/stories/chinese'/f"{j['bookId']}.json")['stories'] for j in jobs}
    for job in jobs:
        id=job['original_id']+'-v2'
        live=next((s for s in source[job['bookId']] if s['id']==id),None)
        if live is None:
            if require_all:errors.append(f'{id}: unpublished')
            continue
        saved=read(STAGE/'stories'/f"{job['original_id']}.json")
        r=read(STAGE/'reviews'/f"{job['original_id']}.json")
        if fingerprint(live)!=fingerprint(saved['story']):errors.append(f'{id}: source mismatch')
        if saved['job_fingerprint']!=fingerprint(job):errors.append(f'{id}: outdated plan')
        errors.extend(f'{id}: {e}' for e in validate(live,job))
        if not approved(saved,r):errors.append(f'{id}: unapproved current version')
        meta=read(STAGE/'images'/f'{id}.json')
        if meta['story_fingerprint']!=fingerprint(live):errors.append(f'{id}: stale image')
        if images:
            review_path=STAGE/'image-reviews'/f'{id}.json'
            illustration=ROOT/'apps/web/public/story-images'/job['bookId']/f'{id}.jpg'
            image_review=read(review_path) if review_path.exists() else {}
            scene=fingerprint({k:live[k] for k in ('title','sentences','image_prompt')})
            if (not image_review.get('approved') or image_review.get('critical_issues')
                or image_review.get('scene_fingerprint')!=scene or not illustration.exists()
                or image_review.get('image_sha256')!=hashlib.sha256(illustration.read_bytes()).hexdigest()):
                errors.append(f'{id}: missing or stale image approval')
        for text in spoken_texts(live):
            rel=audio_path(text);p=AUDIO/rel;audios.add(rel)
            if not p.exists() or not p.stat().st_size:errors.append(f'{id}: missing {rel}')
        web=next((s for s in built[job['bookId']] if s['id']==id),None)
        if not web:
            if require_all:errors.append(f'{id}: not built')
            continue
        media=[web.get('image')]+[s.get('audio') for s in web['sentences']]
        for q in web['questions']:
            media += [q.get('audio',{}).get('question'),q.get('audio',{}).get('explanation')]
            if q['options']:media+=q.get('audio',{}).get('options',[None]*len(q['options']))
        for url in media:
            references+=1
            if not url or not (ROOT/'apps/web/public'/url.lstrip('/')).is_file():errors.append(f'{id}: broken built media {url}')
        if [s['text'] for s in web['sentences']]!=live['sentences']:errors.append(f'{id}: built sentence mismatch')
        for sentence in web['sentences']:
            if sentence.get('audio') != '/audio/' + audio_path(sentence['text']):errors.append(f'{id}: sentence audio/text mismatch')
        web_questions = [{k:v for k,v in q.items() if k!='audio'} for q in web['questions']]
        if web_questions != live['questions']:errors.append(f'{id}: built question mismatch')
        for q in web['questions']:
            qa=q.get('audio',{})
            for field in ('question','explanation'):
                if qa.get(field) != '/audio/' + audio_path(q[field]):errors.append(f'{id}: {field} audio/text mismatch')
            if q['options'] and qa.get('options') != ['/audio/'+audio_path(o) for o in q['options']]:errors.append(f'{id}: option audio/text mismatch')
        rows.append({'id':id,'bookId':job['bookId'],'grade':job['grade'],'title':live['title'],'chars':saved['chars'],
                     'reference_chars':job['baseline_chars'],'ratio':round(saved['chars']/job['baseline_chars'],3),
                     'questions':len(live['questions']),'skills':dict(Counter(q['skill'] for q in live['questions']))})
    if decode:
        def probe(rel):
            p=AUDIO/rel
            result=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_name','-of','json',str(p)],capture_output=True,text=True)
            try:
                d=json.loads(result.stdout)
                assert result.returncode==0 and float(d['format']['duration'])>0 and d['streams'][0]['codec_name']=='opus'
                return None
            except (ValueError,KeyError,AssertionError,IndexError):return f'audio decode: {rel}'
        with ThreadPoolExecutor(max_workers=12) as pool:errors.extend(e for e in pool.map(probe,sorted(audios)) if e)
    report={'published_in_web':len(rows),'total':len(jobs),'questions':sum(r['questions'] for r in rows),
            'media_references':references,'unique_story_audio':len(audios),'audio_decoded':decode,'images_reviewed':images,'errors':errors,'stories':rows}
    write_json(ROOT/'docs/content-revision-results.json',report)
    print(json.dumps({k:v for k,v in report.items() if k!='stories'},ensure_ascii=False,indent=2))
    if errors:raise SystemExit(1)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--all',action='store_true');p.add_argument('--decode',action='store_true');p.add_argument('--images',action='store_true');a=p.parse_args();verify(a.all,a.decode,a.images)
