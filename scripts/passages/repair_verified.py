#!/usr/bin/env python3
"""Apply page-verified extraction repairs, preserving originals and a change log."""
import copy
import json
import re
import shutil
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from content_api import ROOT, write_json

STAGE = ROOT / 'data/content-revision'
LOG = STAGE / 'passage-repairs.json'


def main():
    if LOG.exists():
        print('Already repaired; see', LOG)
        return
    books, originals = {}, {}
    def passage(book, n):
        if book not in books:
            src = ROOT / 'data/passages' / book.split('-')[0] / f'{book}.json'
            backup = STAGE / 'backup/passages' / src.name
            books[book] = json.loads((backup if backup.exists() else src).read_text())
            originals[book] = copy.deepcopy(books[book])
        return next(p for p in books[book]['passages'] if p['id'] == f'{book}-p{n}')

    p = passage('chinese-g2up', 31)
    assert p['sentences'][7].endswith('[?]')
    p['sentences'][7:9] = [p['sentences'][7].replace('[?]', '') + p['sentences'][8]]
    p = passage('chinese-g3up', 11)
    assert p['sentences'][8] == '“ [?] [?] ”，'
    p['sentences'][8] = '“㘗㘗”，'

    p = passage('chinese-g4up', 45)
    assert p['sentences'][-1].endswith('[?]')
    p['sentences'][-1:] = [
        '又过了十天，扁鹊老远望见蔡桓侯，只看了几眼，就掉头跑了。',
        '蔡桓侯觉得奇怪，派人去问他：“扁鹊，你为什么一声不响就跑掉了？”',
        '扁鹊解释道：“病在皮肤上，用热敷就能够治好；发展到皮肉之间，用扎针的方法可以治好；即使发展到肠胃里，服几剂汤药也还能治好；一旦深入骨髓，只能等死，医生再也无能为力了。',
        '现在病已经深入骨髓，所以我不再请求给他医治！”',
        '五天之后，蔡桓侯浑身疼痛，派人去请扁鹊给他治病。',
        '扁鹊早知道蔡桓侯要来请他，几天前就跑到秦国去了。',
        '不久，蔡桓侯病死了。']

    p = passage('chinese-g5down', 10)
    assert p['sentences'][-1] == '原来那大虫拿人，只是[?]'
    p['sentences'][-1:] = [
        '原来那大虫拿人，只是一扑，一掀，一剪，三般提不着时，气性先自没了一半。',
        '那大虫又剪不着，再吼了一声，一兜兜将回来。',
        '武松见那大虫复翻身回来，双手抡起梢棒，尽平生气力，只一棒，从半空劈将下来。',
        '只听得一声响，簌簌地将那树连枝带叶劈脸打将下来。',
        '定睛看时，一棒劈不着大虫。',
        '原来慌了，正打在枯树上，把那条梢棒折做两截，只拿得一半在手里。',
        '那大虫咆哮，性发起来，翻身又只一扑，扑将来。',
        '武松又只一跳，却退了十步远。',
        '那大虫却好把两只前爪搭在武松面前。',
        '武松将半截棒丢在一边，两只手就势把大虫顶花皮揪住，一按按将下来。',
        '那只大虫急要挣扎，早没了气力。',
        '被武松尽气力纳定，那里肯放半点儿松宽。',
        '武松把只脚望大虫面门上、眼睛里只顾乱踢。',
        '那大虫咆哮起来，把身底下扒起两堆黄泥，做了一个土坑。',
        '武松把那大虫嘴直按下黄泥坑里去。',
        '那大虫吃武松奈何得没了些气力。',
        '武松把左手紧紧地揪住顶花皮，偷出右手来，提起铁锤般大小拳头，尽平生之力，只顾打。',
        '打得五七十拳，那大虫眼里、口里、鼻子里、耳朵里都迸出鲜血来。',
        '那武松尽平昔神威，仗胸中武艺，半歇儿把大虫打做一堆，却似躺着一个锦布袋。',
        '武松放了手，来松树边寻那打折的棒橛，拿在手里，只怕大虫不死，把棒橛又打了一回。',
        '那大虫气都没了。',
        '武松再寻思道：“我就地拖得这死大虫下冈子去。”',
        '就血泊里双手来提时，那里提得动？',
        '原来使尽了气力，手脚都疏软了。',
        '武松再来青石坐了半歇，寻思道：“天色看看黑了，倘或又跳出一只大虫来时，我却怎地斗得他过？',
        '且挣扎下冈子去，明早却来理会。”',
        '就石头边寻了毡笠儿，转过乱树林边，一步步挨下冈子来。']

    # The other story's continuation was attached to the wrong title during extraction.
    tree, dog = passage('chinese-g3up', 13), passage('chinese-g3up', 18)
    assert tree['sentences'][25] == '它觉得自己又变成了一棵树。'
    assert tree['sentences'][26] == '竭力忍着不笑出声来。'
    assert dog['sentences'][-1] == '它在地上打着滚，捧着肚子，'
    dog['sentences'][-1] += tree['sentences'][26]
    dog['sentences'].extend(tree['sentences'][27:])
    dog['sentences'] = [s.replace('你这张狗可真特别。', '你这只狗可真特别。') for s in dog['sentences']]
    second_ending = dog['sentences'].index('狗跑啊，跑啊，它碰上了一个农民。')
    dog['sentences'][second_ending] += '……'
    dog['sentences'][-1] += '……'
    tree['sentences'] = tree['sentences'][:26]
    # Preserve punctuation while removing unplayable punctuation-only sentence rows.
    for book, n in [('chinese-g3down',36), ('chinese-g3up',17), ('chinese-g3up',18), ('chinese-g3up',40)]:
        p = passage(book,n)
        merged = []
        for text in p['sentences']:
            if not re.search(r'[\u3400-\u9fffA-Za-z0-9]', text):
                assert merged
                merged[-1] += text
            elif text.startswith('”') and merged:
                merged[-1] += text
            else:
                merged.append(text)
        p['sentences'] = merged

    p = passage('chinese-g5down',20)
    p['sentences'][4] = '字形的象形性较强，写法也不固定，如，“田”字可以写作〔六种甲骨文字形，见课本原页〕。'
    p['sentences'][8] = '有些字形繁简差别很大，如，“车”字早期一般写作〔四种早期金文字形〕，看上去很烦琐，中晚期一般写作〔两种中晚期金文字形〕，与现在的繁体字“車”差别不大。'
    p['readingNote'] = '方括号是古文字图示的说明。请查看课本原页第48页的实际字形；这两句不作跟读音频。'
    p['nonSpokenSentenceIndices'] = [4,8]
    p = passage('english-g4up',7)
    p['sentences'][8] = "What's this? It's a ____."
    p['readingNote'] = '横线来自课本黑板上的填空，保留原样，不直接给出答案；该句不作跟读音频。'
    p['nonSpokenSentenceIndices'] = [8]
    p = passage('english-g6down',14)
    for i in (0,2,4):
        p['sentences'][i] = p['sentences'][i].replace('[?]', '____')
    p['readingNote'] = '这是教材中的听力填空。横线保留原样，未填答案的句子不作跟读音频。'
    p['nonSpokenSentenceIndices'] = [0,2,4]
    p = passage('english-g6up',19)
    p['sentences'][2] = 'Call Amy: 134…'
    p['sentences'][8] = 'Call Mike: 136…'
    p['readingNote'] = '电话号码后面的数字在教材原图中已模糊处理，这里用省略号表示，不补造号码，也不朗读不完整号码。'
    p['nonSpokenSentenceIndices'] = [2,8]

    changes = []
    for book, data in books.items():
        src = ROOT / 'data/passages' / book.split('-')[0] / f'{book}.json'
        backup = STAGE / 'backup/passages' / src.name
        backup.parent.mkdir(parents=True, exist_ok=True)
        if not backup.exists():
            shutil.copy2(src, backup)
        for before, after in zip(originals[book]['passages'],data['passages']):
            if before != after:
                changes.append({'bookId': book, 'id': after['id'], 'title': after['title'], 'before': before, 'after': after})
        write_json(src,data)
    # The complete Jingyanggang text needs more than the previous three-page window.
    mapping = ROOT / 'apps/web/public/textbook-pages/chinese-g5down/pages.json'
    d = json.loads(mapping.read_text())
    backup = STAGE / 'backup/pages/chinese-g5down.json'
    if not backup.exists():
        write_json(backup,d)
    next(p for p in d['passages'] if p['passage_id']=='chinese-g5down-p10')['pages'] = [i for i in range(27,33) if (mapping.parent/f'p{i}.jpg').exists()]
    write_json(mapping,d)
    write_json(LOG,{'verified_source': 'Local textbook page images; misplaced 小狗学叫 continuation recovered from existing extracted source, original continuation page image unavailable.', 'changes': changes})
    print('Repaired',len(changes),'passages; originals backed up')

if __name__ == '__main__':
    main()
