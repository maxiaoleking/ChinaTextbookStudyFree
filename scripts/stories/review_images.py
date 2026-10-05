#!/usr/bin/env python3
"""Inspect scene consistency with the requested Luna model; fix critical issues with Muse."""
import argparse
import base64
import hashlib
from concurrent.futures import ThreadPoolExecutor,as_completed
from revise import *
from revision_media import image
from run_revision import approved

SCENE_SCHEMA=obj({'approved':{'type':'boolean'},'critical_issues':STRINGS,'scene_summary':STR})

def inspect(saved,allow_repair):
    s=saved['story'];path=ROOT/'apps/web/public/story-images'/s['bookId']/f"{s['id']}.jpg"
    out=STAGE/'image-reviews'/f"{s['id']}.json"
    source=STAGE/'stories'/f"{saved['job']['original_id']}.json"
    metadata=STAGE/'images'/f"{s['id']}.json"
    scene_digest=fingerprint({'title':s['title'],'sentences':s['sentences'],'image_prompt':s['image_prompt']})
    for attempt in range(3 if allow_repair else 1):
        if not source.exists() or fingerprint(read(source)['story'])!=fingerprint(s):return 'deferred changed story '+s['id']
        digest=hashlib.sha256(path.read_bytes()).hexdigest()
        if out.exists():
            cached=read(out)
            if cached.get('image_sha256')==digest and cached.get('scene_fingerprint')==scene_digest and cached.get('approved') and not cached.get('critical_issues'):return 'cached '+s['id']
        prompt=('你是儿童文学插画审稿人。核对画面与故事是否一致，是否存在严重人物肢体/物体结构错误、关键人物动作矛盾、可辨认的题目答案/水印/无关文字，或明显不适合该年龄。'
                '一张图只需表现故事中的一个场景，不要求表现全文；允许风格变化、合理简化、微小透视误差、不可读的报纸纹理。不要把审美偏好或未出现次要道具判为错误。'
                '不要只凭短发、服装颜色或装饰猜测人物性别；修补已经完成时不必能看出被覆盖的破口，细小白缝等非关键细节可以合理简化。'
                '只有影响理解或使用的实质问题才写critical_issues。无实质问题approved=true。\n'
                +json.dumps({'grade':saved['job']['grade'],'title':s['title'],'story':s['sentences'],
                             'intended_scene':read(metadata).get('prompt',s['image_prompt']) if metadata.exists() else s['image_prompt']},ensure_ascii=False))
        content=[{'type':'text','text':prompt},{'type':'image_url','image_url':{'url':'data:image/jpeg;base64,'+base64.b64encode(path.read_bytes()).decode(),'detail':'high'}}]
        result=json.loads(chat(MODEL,content,SCENE_SCHEMA,max_tokens=2500,reasoning={'effort':'low'})['content'])
        if not source.exists() or fingerprint(read(source)['story'])!=fingerprint(s) or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:return 'deferred changed input '+s['id']
        result.update(image_sha256=digest,scene_fingerprint=scene_digest,model=MODEL)
        write_json(out,result)
        if result['approved'] and not result['critical_issues']:return 'IMAGE APPROVED '+s['id']
        if allow_repair and attempt<2:
            print('REPAIR IMAGE '+s['id']+': '+str(result['critical_issues']),flush=True)
            image(saved,feedback=result['critical_issues'])
    raise ValueError(s['id']+': '+str(result['critical_issues']))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--repair',action='store_true');p.add_argument('--workers',type=int,default=4);a=p.parse_args()
    items=[]
    for path in (STAGE/'stories').glob('*.json'):
        d=read(path);rp=STAGE/'reviews'/path.name;meta=STAGE/'images'/f"{d['story']['id']}.json"
        if rp.exists() and approved(d,read(rp)) and meta.exists() and read(meta).get('story_fingerprint')==fingerprint(d['story']):items.append(d)
    print('Image reviews:',len(items),flush=True)
    failed=[]
    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        for f in as_completed([pool.submit(inspect,d,a.repair) for d in items]):
            try:print(f.result(),flush=True)
            except Exception as e:failed.append(str(e));print('FAILED',e,flush=True)
    if failed:raise SystemExit(1)
