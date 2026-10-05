#!/usr/bin/env python3
"""Tighten exact-text fill instructions and excessive option length after publication.
Stages reviewed amendments; the coordinator applies them after the main writer stops.
"""
import argparse
import copy
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from revise import *
from revision_media import image, synthesize, AUDIO
from run_revision import approved


def process(path):
    saved=read(path);old=copy.deepcopy(saved)
    changed=fix_fill_instructions(saved['story']);long=long_options(saved)
    if not changed and not long:return 'unchanged '+path.stem
    source=read(ROOT/'data/stories/chinese'/f"{saved['job']['bookId']}.json")
    current=next(s for s in source['stories'] if s['id']==saved['story']['id'])
    saved['replaces_published_fingerprint']=fingerprint(current)
    write_json(STAGE/'history'/f'{path.stem}-question-clarity-before.json',old)
    if long:
        prompt=('你是小学语文编辑。只修改题目，不改正文。以下题号的选项过长：'+str(long)
                +'。将每个选项限制在'+str(option_limit(saved['job']['grade']))+'字以内，保留原题能力标签、题型、题号和正确含义，干扰项合理、长度相近。'
                '题干也应简明，填空保留精确字数要求。返回完整questions数组。\n'+json.dumps(saved,ensure_ascii=False))
        out=json.loads(chat(MODEL,prompt,obj({'questions':{'type':'array','items':QUESTION}}),max_tokens=7000,reasoning={'effort':'high'})['content'])
        saved['story']['questions']=out['questions'];balance_choices(saved['story'],saved['job']['original_id']);fix_fill_instructions(saved['story'])
    write_json(path,saved)
    for attempt in range(5):
        saved=read(path);errors=validate(saved['story'],saved['job'])
        errors += [f'题{q}选项超过{option_limit(saved["job"]["grade"])}字，请压缩' for q in long_options(saved)]
        if errors:
            write_json(STAGE/'reviews'/path.name,{'approved':False,'issues':errors,'story_fingerprint':fingerprint(saved['story'])})
        else:
            review(path)
            if approved(saved,read(STAGE/'reviews'/path.name)):break
        if attempt==4:raise ValueError(path.stem+': revision needs further review')
        repair(path)
        saved=read(path)
        if fix_fill_instructions(saved['story']):write_json(path,saved)
    print(image(saved),flush=True)
    items={audio_path(t):{'text':t,'audio_rel':audio_path(t),'grade':saved['job']['grade']} for t in spoken_texts(saved['story'])}
    with ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(synthesize,items.values()))
    return 'READY amendment '+path.stem


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--workers',type=int,default=4);a=parser.parse_args()
    run=read(STAGE/'run-status.json');active=set(run['active']);paths=[]
    for p in sorted((STAGE/'stories').glob('*.json')):
        if p.stem in active:continue
        d=read(p);source=read(ROOT/'data/stories/chinese'/f"{d['job']['bookId']}.json")
        if not any(s['id']==d['story']['id'] for s in source['stories']):continue
        candidate=copy.deepcopy(d['story'])
        if fix_fill_instructions(candidate) or long_options(d):paths.append(p)
    print('Refining',len(paths),'published stories',flush=True)
    failures=[]
    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        for f in as_completed([pool.submit(process,p) for p in paths]):
            try:print(f.result(),flush=True)
            except Exception as e:failures.append(str(e));print('FAILED',e,flush=True)
    if failures:raise SystemExit(1)

if __name__=='__main__':main()
