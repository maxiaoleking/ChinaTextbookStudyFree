/**
 * pinyinSpeak.ts — 拼音音节 → 可播报文本 / 本地音频键
 *
 * 本地音频镜像（scripts/renzi/build_renzi_audio.py 产出）：
 *   /audio/pinyin/{key}.mp3
 *   tiān → tian1.mp3，wǒ → wo3.mp3，de → de0.mp3
 * 优先 Wikimedia Commons / Lingua Libre 真人录音，缺项用 edge-tts 晓伊补，
 *  attribution 见同目录 CREDITS.json。仅供本机与局域网教学，不公开分发。
 */

export const TONE_MAP: Record<string, [string, number]> = {
  "ā": ["a", 1], "á": ["a", 2], "ǎ": ["a", 3], "à": ["a", 4],
  "ē": ["e", 1], "é": ["e", 2], "ě": ["e", 3], "è": ["e", 4],
  "ī": ["i", 1], "í": ["i", 2], "ǐ": ["i", 3], "ì": ["i", 4],
  "ō": ["o", 1], "ó": ["o", 2], "ǒ": ["o", 3], "ò": ["o", 4],
  "ū": ["u", 1], "ú": ["u", 2], "ǔ": ["u", 3], "ù": ["u", 4],
  "ǖ": ["v", 1], "ǘ": ["v", 2], "ǚ": ["v", 3], "ǜ": ["v", 4],
  "ü": ["v", 0],
};

/** 认字题高频拼音 → 例字（TTS 用例字音更稳；也可人工听辨） */
export const PINYIN_EXAMPLE_CHAR: Record<string, string> = {
  a: "啊", o: "喔", e: "鹅", i: "衣", u: "乌", v: "迂", ü: "迂",
  ai: "爱", ei: "诶", ui: "威", ao: "熬", ou: "欧", iu: "优",
  ie: "耶", üe: "约", er: "耳", an: "安", en: "恩", in: "因",
  un: "温", ang: "昂", eng: "鞥", ing: "英", ong: "翁",
  ba: "八", pa: "趴", ma: "妈", fa: "发", da: "大", ta: "他",
  na: "那", la: "拉", ga: "嘎", ka: "卡", ha: "哈",
  bi: "比", pi: "皮", mi: "米", di: "地", ti: "提", ni: "你", li: "里",
  ji: "几", qi: "七", xi: "西",
  bu: "不", pu: "铺", mu: "木", fu: "服", du: "读", tu: "土", nu: "怒",
  lu: "路", gu: "古", ku: "苦", hu: "湖", ju: "句", qu: "去", xu: "需",
  zhu: "住", chu: "出", shu: "书", ru: "如", zu: "组", cu: "粗", su: "苏",
  bo: "波", po: "坡", mo: "摸", fo: "佛", de: "的", te: "特", ne: "呢",
  le: "了", ge: "个", ke: "可", he: "和", zhe: "这", che: "车", she: "是",
  re: "热", ze: "则", ce: "册", se: "色",
  bai: "白", pai: "拍", mai: "买", dai: "带", tai: "太", nai: "奶",
  lai: "来", gai: "该", kai: "开", hai: "海", zhai: "摘", chai: "拆",
  shai: "晒", zai: "在", cai: "菜", sai: "赛",
  bei: "被", pei: "配", mei: "美", fei: "飞", dei: "得", nei: "内",
  lei: "泪", gei: "给", hei: "黑", zhei: "这", shei: "谁", zei: "贼",
  bao: "包", pao: "跑", mao: "猫", dao: "到", tao: "桃", nao: "脑",
  lao: "老", gao: "高", kao: "考", hao: "好", zhao: "找", chao: "朝",
  shao: "少", rao: "绕", zao: "早", cao: "草", sao: "扫",
  dou: "都", tou: "头", nou: "耨", lou: "楼", gou: "狗", kou: "口",
  hou: "后", zhou: "周", chou: "抽", shou: "手", rou: "肉", zou: "走",
  cou: "凑", sou: "搜",
  bian: "边", pian: "片", mian: "面", dian: "点", tian: "天", nian: "年",
  lian: "连", jian: "见", qian: "前", xian: "先",
  bing: "并", ping: "平", ming: "明", ding: "定", ting: "听", ning: "宁",
  ling: "零", jing: "京", qing: "青", xing: "星",
  bang: "帮", pang: "旁", mang: "忙", fang: "方", dang: "当", tang: "糖",
  nang: "囊", lang: "狼", gang: "刚", kang: "康", hang: "行",
  zhang: "张", chang: "长", shang: "上", rang: "让", zang: "脏",
  cang: "藏", sang: "桑",
  beng: "崩", peng: "朋", meng: "梦", feng: "风", deng: "等", teng: "疼",
  neng: "能", leng: "冷", geng: "更", keng: "坑", heng: "横",
  zheng: "正", cheng: "成", sheng: "生", reng: "仍", zeng: "增",
  ceng: "层", seng: "僧",
  dong: "东", tong: "同", nong: "农", long: "龙", gong: "工", kong: "空",
  hong: "红", zhong: "中", chong: "虫", rong: "荣", zong: "总",
  cong: "从", song: "送",
  wo: "我", yo: "哟",
  yu: "雨", yue: "月", yuan: "元", yun: "云", ying: "鹰", yi: "一",
  ya: "呀", ye: "也", yao: "要", you: "有", yan: "言", yang: "羊",
  yong: "用", wu: "五", wa: "娃", wai: "外", wei: "为", wan: "万",
  wen: "文", wang: "王", weng: "翁",
  zhi: "知", chi: "吃", shi: "是", ri: "日", zi: "子", ci: "次", si: "四",
  nü: "女", nv: "女", lü: "绿", lv: "绿",
  jia: "家", qia: "恰", xia: "下", jiao: "叫", qiao: "桥", xiao: "小",
  jiu: "九", qiu: "秋", xiu: "休", jin: "金", qin: "亲", xin: "心",
  jiang: "江", qiang: "强", xiang: "想", jiong: "窘", qiong: "穷",
  xiong: "兄",
  zhuai: "拽", chuai: "踹", shuai: "帅", zhuang: "装", chuang: "床",
  shuang: "双", zhun: "准", chun: "春", shun: "顺", run: "润", zun: "尊",
  cun: "村", sun: "孙",
  diao: "掉", tiao: "跳", niao: "鸟", liao: "了", gua: "瓜", kua: "夸",
  hua: "花", zhua: "抓", chua: "欻", shua: "刷", guo: "过", kuo: "阔",
  huo: "火", ruo: "若", zuo: "做", cuo: "错", suo: "所",
  kui: "亏", hui: "会", zhui: "追", chui: "吹", shui: "水", rui: "瑞",
  zui: "最", cui: "翠", sui: "岁",
  man: "满", fan: "饭", dan: "但", tan: "谈", nan: "南", lan: "蓝",
  gan: "干", kan: "看", han: "汉", zhan: "站", chan: "产", shan: "山",
  ran: "然", zan: "赞", can: "参", san: "三",
  men: "门", fen: "分", den: "扽", nen: "嫩", gen: "根", ken: "肯",
  hen: "很", zhen: "真", chen: "陈", shen: "身", ren: "人", zen: "怎",
  cen: "岑", sen: "森",
  bin: "宾", pin: "品", min: "民", nin: "您", lin: "林",
  guan: "关", kuan: "宽", huan: "欢", zhuan: "转", chuan: "穿",
  shuan: "栓", ruan: "软", zuan: "钻", cuan: "窜", suan: "算",
  gun: "滚", kun: "困", hun: "混",
  nüe: "虐", lüe: "略", jue: "觉", que: "却", xue: "学",
  // 声母代表字（与 Panda 字母表一致，便于「读作」）
  b: "玻", p: "坡", m: "摸", f: "佛", d: "得", t: "特", n: "讷", l: "勒",
  g: "歌", k: "科", h: "喝", j: "基", q: "欺", x: "希",
  zh: "知", ch: "吃", sh: "师", r: "日", z: "资", c: "雌", s: "思",
  y: "衣", w: "乌",
};

const PY_ONLY = /^[a-zA-ZüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+$/;

export function isPinyinText(text: string): boolean {
  return PY_ONLY.test((text || "").trim());
}

/** tiān → tian1 */
export function pinyinKey(py: string): string {
  let tone = 0;
  let base = "";
  for (const ch of (py || "").trim()) {
    const hit = TONE_MAP[ch];
    if (hit) {
      base += hit[0];
      if (hit[1]) tone = hit[1];
    } else if (ch === "ü") {
      base += "v";
    } else {
      base += ch.toLowerCase();
    }
  }
  return `${base}${tone}`;
}

/** 本地镜像音频路径；非拼音返回 null */
export function localPinyinAudioSrc(text: string): string | null {
  const t = (text || "").trim();
  if (!isPinyinText(t)) return null;
  return `/audio/pinyin/${pinyinKey(t)}.mp3`;
}

export function pinyinExampleChar(py: string): string | null {
  const key = pinyinKey(py);
  const bare = key.replace(/[0-5]$/, "");
  return PINYIN_EXAMPLE_CHAR[key] ?? PINYIN_EXAMPLE_CHAR[bare] ?? PINYIN_EXAMPLE_CHAR[bare.replace(/^v$/, "ü")] ?? null;
}

/**
 * 在线加强：Panda Learn Chinese Polly（与站内 /polly/speak 一致）。
 * 浏览器 <audio> 跨域播放不需要 CORS；失败自动回落本地镜像。
 */
export const POLLY_BASE = "https://www.pandalearnchinese.com/polly/speak/";

const ONLINE_KEY = "csf-online-polly";

/** 在线加强默认关闭：本地镜像已是真人/AI 双备的高质量音，第三方站点不该是默认路径。 */
export function isOnlinePollyEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(ONLINE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOnlinePollyEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(ONLINE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** 可走 Polly 的文本：拼音或含汉字的短句 */
export function onlinePollySrc(text: string): string | null {
  const t = (text || "").trim();
  if (!t || t.length > 80) return null;
  const hasHan = /[一-鿿]/.test(t);
  const isPy = isPinyinText(t);
  if (!hasHan && !isPy) return null;
  return POLLY_BASE + encodeURIComponent(t);
}

/**
 * Web Speech / 本地 say 的播报文案。
 * 有例字时：「地，dì」——中文音色读汉字更稳；否则分音节 + 声调名。
 */
export function pinyinToSpeakable(py: string): string {
  const t = (py || "").trim();
  if (!isPinyinText(t)) return t;
  const key = pinyinKey(t);
  const ex = pinyinExampleChar(t);
  let tone = "";
  let base = "";
  for (const ch of t) {
    const hit = TONE_MAP[ch];
    if (hit) {
      base += hit[0];
      if (!tone && hit[1]) tone = String(hit[1]);
    } else {
      base += ch.toLowerCase();
    }
  }
  const label =
    tone === "1" ? "一声" : tone === "2" ? "二声" : tone === "3" ? "三声" : tone === "4" ? "四声" : "轻声";
  if (ex) return `${ex}，${base}，${label}`;
  return `读作 ${base.split("").join(".")}. ${label}`;
}
