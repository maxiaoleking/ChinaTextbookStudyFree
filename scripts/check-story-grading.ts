/** Verify the real story question bank through the same grader used by the reader. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gradeAnswer } from '../packages/core/src/grade';
import type { Question } from '../packages/core/src/types';
let count = 0;
for (const subject of ['chinese','english']) {
  const folder=path.resolve('data/stories',subject);
  for (const file of fs.readdirSync(folder).filter(f=>f.endsWith('.json'))) {
    const data=JSON.parse(fs.readFileSync(path.join(folder,file),'utf8'));
    for(const story of data.stories) for(const q of story.questions as Question[]) {
      const label=`${story.id} #${q.id}`;
      if(q.type==='choice') {
        const idx=q.options!.indexOf(q.answer);
        assert(idx>=0,label+': answer not in options');
        q.options!.forEach((_,i)=>assert.equal(gradeAnswer(q,String.fromCharCode(65+i)),i===idx,label));
      } else {
        assert(gradeAnswer(q,q.answer),label);
        assert(!gradeAnswer(q,'不存在的答案'),label);
        if(q.type==='true_false') {
          const correctTrue = ['对','正确','true'].includes(q.answer.toLowerCase());
          assert.equal(gradeAnswer(q,'对'),correctTrue,label);
          assert.equal(gradeAnswer(q,'错'),!correctTrue,label);
        }
      }
      assert(!gradeAnswer(q,''),label);
      count++;
    }
  }
}
console.log(`PASS: ${count} story questions; correct, incorrect, and empty submissions.`);
