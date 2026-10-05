#!/usr/bin/env python3
"""Remove predictable answer positions without changing reviewed question content.

Run only after generators/editorial writers stop. Preserve the original model
review and a machine-checkable proof that only option order changed.
"""
import copy
from revise import *
from run_revision import approved


def semantic_content(story):
    result=copy.deepcopy(story)
    for q in result['questions']:
        q['options']=sorted(q['options'])
    return result


def main(exclude=()):
    changed=[]
    for path in sorted((STAGE/'stories').glob('*.json')):
        if path.stem in exclude:continue
        saved=read(path);before=copy.deepcopy(saved['story'])
        positions=[q['options'].index(q['answer']) for q in before['questions'] if q['type']=='choice']
        predictable=len(positions)>=4 and any(all((positions[i+1]-positions[i])%4==step for i in range(3)) for step in (1,3))
        if not predictable:continue
        rp=STAGE/'reviews'/path.name;result=read(rp)
        if not approved(saved,result):raise ValueError(path.stem+': unapproved source')
        balance_choices(saved['story'],saved['job']['original_id'])
        assert semantic_content(before)==semantic_content(saved['story'])
        assert not validate(saved['story'],saved['job'])
        old=fingerprint(before);new=fingerprint(saved['story'])
        mp=STAGE/'images'/f"{before['id']}.json";meta=read(mp)
        if meta['story_fingerprint']!=old:raise ValueError(path.stem+': stale image')
        source=read(ROOT/'data/stories/chinese'/f"{saved['job']['bookId']}.json")
        live=next(s for s in source['stories'] if s['id']==before['id'])
        saved['replaces_published_fingerprint']=fingerprint(live)
        proof={'transformation':'choice_option_permutation_only','semantic_content_unchanged':True,
               'before_story_fingerprint':old,'after_story_fingerprint':new,'original_model_review':result}
        proof_path=STAGE/'history'/f'{path.stem}-choice-order-proof.json'
        write_json(proof_path,{'proof':proof,'before':before,'after':saved['story']})
        result={**result,'story_fingerprint':new,'post_review_transformation':proof['transformation'],
                'source_review_story_fingerprint':old,'transformation_proof':str(proof_path)}
        meta['story_fingerprint']=new
        write_json(path,saved);write_json(rp,result);write_json(mp,meta)
        changed.append(path.stem)
    print('Rebalanced reviewed stories:',len(changed),changed)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exclude',nargs='*',default=[])
    args=parser.parse_args();main(set(args.exclude))
