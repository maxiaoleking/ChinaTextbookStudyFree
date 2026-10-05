#!/usr/bin/env python3
"""Write a public, secret-free snapshot from built data and current revision status."""
import argparse
import time
from pathlib import Path
from revise import ROOT, STAGE, read, write_json, chars


def snapshot():
    jobs = read(STAGE/'plan.json')
    source_ids = {s['id'] for p in (ROOT/'data/stories/chinese').glob('*.json') for s in read(p)['stories']}
    rows = []
    for job in jobs:
        book = job['bookId']
        path = ROOT/'apps/web/public/data/books'/book/'stories.json'
        if not path.exists():
            continue
        stories = read(path)['stories']
        s = next((s for s in stories if s['id']==job['original_id']+'-v2'),None)
        if s is None:
            continue
        rows.append({'id':s['id'],'bookId':book,'grade':job['grade'],'title':s['title'],
                     'chars':chars([sentence['text'] for sentence in s['sentences']]),'baseline':job['baseline_chars'],'questions':len(s['questions']),
                     'unit':job['unitNumber'],'term':'上册' if 'up' in book else '下册'})
    run = read(STAGE/'run-status.json')
    data = {'updatedAt':int(time.time()*1000),'total':len(jobs),'published':len(rows),
            'ready':sum(j['original_id']+'-v2' in source_ids for j in jobs),
            'questions':sum(s['questions'] for s in rows),'failed':sum(id+'-v2' not in source_ids for id in run['failed']),
            'active':len(run['active']),'stories':rows}
    write_json(ROOT/'apps/web/public/content-revision-status.json',data)
    return len(run['completed'])+len(run['failed'])==run['total']


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--watch',action='store_true');a=p.parse_args()
    while True:
        try:
            done=snapshot()
        except (FileNotFoundError,ValueError):
            done=False
        if not a.watch or done:break
        time.sleep(10)
