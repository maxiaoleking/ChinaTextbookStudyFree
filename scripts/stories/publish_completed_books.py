#!/usr/bin/env python3
"""Publish ready amendments only for books the main coordinator has finished writing."""
from revise import *

run=read(STAGE/'run-status.json')
done=set(run['completed'])|set(run['failed'])
jobs=read(STAGE/'plan.json')
selection = read(STAGE/'run-selection.json') if (STAGE/'run-selection.json').exists() else {}
scheduled = set(selection['ids']) if selection.get('started_at') == run['started_at'] else {j['original_id'] for j in jobs}
count=0
for p in sorted((STAGE/'stories').glob('*.json')):
    d=read(p);book=d['job']['bookId'];id=d['job']['original_id']
    if not all(j['original_id'] in done for j in jobs if j['bookId']==book and j['original_id'] in scheduled):continue
    source=read(ROOT/'data/stories/chinese'/f'{book}.json')
    live=next((s for s in source['stories'] if s['id']==d['story']['id']),None)
    if live and fingerprint(live)==fingerprint(d['story']):continue
    try:apply([p]);count+=1
    except ValueError:continue  # Unreviewed or incomplete media stays staged.
print('Published',count,'ready amendments/recoveries')
