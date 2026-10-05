#!/usr/bin/env python3
"""Resume the full revision with bounded workers and publish only complete stories."""
import argparse
import json
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from revise import STAGE, ROOT, read, write_json, fingerprint, generate, review, repair, apply, spoken_texts
from revision_media import image, synthesize, AUDIO, audio_path


def approved(saved, result):
    return (result.get('story_fingerprint') == fingerprint(saved['story']) and result.get('approved')
            and result.get('answers_verified') and not result.get('issues')
            and all(result.get(k, 0) >= 4 for k in ('literary_quality', 'grade_fit', 'question_quality')))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers', type=int, default=8)
    parser.add_argument('--audio-workers', type=int, default=16)
    parser.add_argument('--ids', nargs='*')
    args = parser.parse_args()
    jobs = read(STAGE / 'plan.json')
    if args.ids:
        jobs = [j for j in jobs if j['original_id'] in args.ids]
    published = {s['id'] for p in (ROOT / 'data/stories/chinese').glob('*.json') for s in read(p)['stories']}
    lock = threading.Lock()
    audio_futures = {}
    status = {'started_at': time.time(), 'total': len(jobs), 'completed': [], 'failed': {}, 'active': {}}
    write_json(STAGE / 'run-selection.json', {'started_at': status['started_at'], 'ids': [j['original_id'] for j in jobs]})

    def update(id, step):
        with lock:
            status['active'][id] = step
            status['updated_at'] = time.time()
            write_json(STAGE / 'run-status.json', status)
        print(f'{id}: {step}', flush=True)

    with ThreadPoolExecutor(max_workers=args.audio_workers) as audio_pool, ThreadPoolExecutor(max_workers=4) as image_pool:
        def process(job):
            id = job['original_id']
            path = STAGE / 'stories' / f'{id}.json'
            if id + '-v2' in published:
                return None  # Published stories are owned by the separate editorial pass.
            update(id, 'generating')
            generate(job)
            for attempt in range(5):
                update(id, f'reviewing {attempt + 1}')
                review(path)
                saved = read(path)
                result = read(STAGE / 'reviews' / path.name)
                if approved(saved, result):
                    break
                if attempt == 4:
                    raise ValueError('review failed: ' + json.dumps(result['issues'], ensure_ascii=False))
                update(id, f'repairing {attempt + 1}')
                repair(path)
            update(id, 'image and audio')
            image_future = image_pool.submit(image, saved)
            futures = []
            for text in spoken_texts(saved['story']):
                rel = audio_path(text)
                if (AUDIO / rel).exists() and (AUDIO / rel).stat().st_size:
                    continue
                with lock:
                    if rel not in audio_futures:
                        audio_futures[rel] = audio_pool.submit(synthesize, {'text': text, 'audio_rel': rel, 'grade': job['grade']})
                    futures.append(audio_futures[rel])
            image_future.result()
            for future in futures:
                future.result()
            return path

        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            pending = {pool.submit(process, j): j['original_id'] for j in jobs}
            published_since_build = 0
            for future in as_completed(pending):
                id = pending[future]
                try:
                    path = future.result()
                    # The coordinator is the only source writer; no concurrent read/replace races.
                    if path is not None:
                        apply([path])
                    with lock:
                        status['completed'].append(id)
                    published_since_build += int(path is not None)
                    print(f'{"PUBLISHED" if path is not None else "CACHED"} {id}', flush=True)
                    if published_since_build >= 16:
                        subprocess.run(['npm', 'run', 'build:data', '--workspace=china-study-free'], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
                        published_since_build = 0
                except Exception as exc:
                    with lock:
                        status['failed'][id] = str(exc)
                    print(f'FAILED {id}: {exc}', flush=True)
                with lock:
                    status['active'].pop(id, None)
                    status['updated_at'] = time.time()
                    write_json(STAGE / 'run-status.json', status)
    subprocess.run(['npm', 'run', 'build:data', '--workspace=china-study-free'], cwd=ROOT, check=True)
    print(json.dumps({'completed': len(status['completed']), 'failed': status['failed']}, ensure_ascii=False), flush=True)
    if status['failed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
