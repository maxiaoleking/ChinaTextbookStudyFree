#!/usr/bin/env python3
"""Recover rejected drafts using their actual text and measured length as feedback."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import argparse
from revise import *
from run_revision import approved


def recover(job):
    id=job['original_id'];path=STAGE/'stories'/f'{id}.json'
    if not path.exists():
        attempts=sorted((STAGE/'attempts').glob(id+'-*.json'),key=lambda p:p.stat().st_mtime)
        draft=read(attempts[-1])['story'] if attempts else None
        for i in range(5):
            current=chars(draft['sentences']) if draft else 0
            extra=max(80,job['baseline_chars']-current)
            prompt=(f'你是小学语文编辑。修订下面的真实草稿，正文目前{current}汉字，需要{job["min_chars"]}至{job["max_chars"]}汉字（不含标点）。'
                    f'建议目标{job["baseline_chars"]}汉字。若篇幅不足，请增加约{extra}汉字的具体行动、对话和合理细节，不堆空话、不反复解释。'
                    '保持年级、单元要求和题量，选择题唯一正确且干扰项合理。填空必须注明精确答案字数。推断不能复述明说的信息。'
                    '必须覆盖 retrieval/vocabulary/inference，三年级起加 expression，五年级起加 structure。'
                    '按修改后的完整正文更新所有题目证据句号和插画描述。返回完整JSON。\n'
                    +json.dumps({'job':job,'draft':draft,'validation_errors':validate(draft,job) if draft else []},ensure_ascii=False))
            draft=json.loads(chat(MODEL,prompt,SCHEMA,max_tokens=16000,reasoning={'effort':'high'})['content'])
            fix_fill_instructions(draft)
            errors=validate(draft,job)
            write_json(STAGE/'attempts'/f'{id}-recovery-{i}.json',{'story':draft,'errors':errors})
            if not errors:break
        else:raise ValueError(id+': '+str(errors))
        balance_choices(draft,id)
        draft.update(id=id+'-v2',bookId=job['bookId'],unitNumber=job['unitNumber'],unitTitle=job['unitTitle'],storyIndex=job['storyIndex'],language='Chinese')
        write_json(path,{'job':job,'job_fingerprint':fingerprint(job),'story':draft,'model':MODEL,'chars':chars(draft['sentences'])})
    for i in range(5):
        review(path)
        if approved(read(path),read(STAGE/'reviews'/path.name)):
            print('RECOVERED',id,flush=True);return
        if i<4:repair(path)
    raise ValueError(id+': still needs editorial review')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ids',nargs='+')
    parser.add_argument('--media',action='store_true')
    parser.add_argument('--workers',type=int,default=2)
    args=parser.parse_args()
    run=read(STAGE/'run-status.json')
    ids=set(args.ids or run['failed'])
    if ids.intersection(run['active']):raise SystemExit('Cannot recover jobs still active in main runner')
    jobs=[j for j in read(STAGE/'plan.json') if j['original_id'] in ids]
    def task(job):
        recover(job)
        if args.media:
            from revision_media import image,synthesize
            saved=read(STAGE/'stories'/f"{job['original_id']}.json")
            print(image(saved),flush=True)
            with ThreadPoolExecutor(max_workers=12) as audio_pool:
                list(audio_pool.map(synthesize,[{'text':t,'audio_rel':audio_path(t),'grade':job['grade']} for t in spoken_texts(saved['story'])]))
            print('MEDIA READY',job['original_id'],flush=True)
    failures=[]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for f in as_completed([pool.submit(task,j) for j in jobs]):
            try:f.result()
            except Exception as e:failures.append(str(e));print('FAILED',e,flush=True)
    if failures:raise SystemExit(1)
