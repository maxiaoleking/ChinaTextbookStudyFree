#!/usr/bin/env python3
"""Inspect every logged Gemini output as audio, not just a filename with an Opus suffix."""
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from revise import STAGE, write_json
from revision_media import AUDIO, TTS_MODEL

items={}
for line in (STAGE/'usage.jsonl').read_text().splitlines():
    try:r=json.loads(line)
    except ValueError:continue
    if r.get('model')==TTS_MODEL and r.get('audio_rel'):items[r['audio_rel']]=r

def inspect(item):
    rel,r=item
    p=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_name','-of','json',str(AUDIO/rel)],capture_output=True,text=True)
    result={'audio_rel':rel,'characters':r['characters'],'voice':r['voice']}
    try:
        d=json.loads(p.stdout);duration=float(d['format']['duration'])
        assert p.returncode==0 and duration>0 and d['streams'][0]['codec_name']=='opus'
        result.update(duration=duration,characters_per_second=round(r['characters']/duration,2),valid=True)
    except (AssertionError,KeyError,ValueError,IndexError):result['valid']=False
    return result

with ThreadPoolExecutor(max_workers=12) as pool:results=list(pool.map(inspect,items.items()))
invalid=[r for r in results if not r['valid']]
suspect=[r for r in results if r['valid'] and r['characters']>10 and (r['characters_per_second']>15 or r['characters_per_second']<.7)]
write_json(STAGE/'audio-verification-all.json',{'checked':len(results),'invalid':invalid,'duration_outliers':suspect,'files':results})
print(json.dumps({'checked':len(results),'invalid':invalid,'duration_outliers':suspect},ensure_ascii=False,indent=2))
if invalid:raise SystemExit(1)
