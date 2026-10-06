#!/usr/bin/env python3
"""生成「美国英语」科目（CCSS ELA Grade 1）output/ela/{outlines,quizzes}。

内容依据 Common Core State Standards for English Language Arts, Grade 1
（RF / RL / RI / W / L 五条线索，编号已对官方 PDF 逐条核对：RF.1.1 只有子项 a，
RF.1.3 为 a–g，最终版没有 RF.1.5；L.1.1 为 a–j，L.1.2 为 a–e，L.1.4 只有 a–c），
词表用 Dolch Primer(52) + Dolch Grade 1(41) + Fry 1–100 与常规自然拼读词族。

题干、选项、讲解一律写成英文 —— scripts/ela/build_ela_audio.py 只对纯 ASCII 文本
合成人声，中文（大纲描述、knowledge_summary）留给前端系统语音兜底。
"""

from __future__ import annotations

import json
import random
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
OUTLINE_DIR = ROOT / "output" / "ela" / "outlines"
QUIZ_DIR = ROOT / "output" / "ela" / "quizzes"

TEXTBOOK = "CCSS 美国小学英语一年级上册"
STEM = "美国小学英语一年级上册"

# ============================================================
# 素材库
# ============================================================

LETTERS = "abcdefghijklmnopqrstuvwxyz"

# CVC 短元音词族（-ud/-ed/-ib 词量太小，只用于填空不用于「词族成员」判定）
CVC: dict[str, list[str]] = {
    "at": ["bat", "cat", "hat", "mat", "rat", "sat", "fat"],
    "et": ["bet", "get", "jet", "let", "met", "net", "pet", "set", "wet"],
    "id": ["bid", "did", "hid", "kid", "rid"],
    "ig": ["big", "dig", "pig", "wig", "rig", "jig"],
    "ot": ["cot", "dot", "got", "hot", "lot", "not", "pot", "tot"],
    "ug": ["bug", "dug", "hug", "jug", "mug", "rug", "tug"],
    "ap": ["cap", "gap", "lap", "map", "nap", "sap", "tap"],
    "en": ["den", "hen", "pen", "ten", "men"],
    "in": ["bin", "fin", "pin", "win"],
    "og": ["dog", "fog", "jog", "log"],
    "op": ["cop", "hop", "mop", "pop", "top"],
    "ub": ["cub", "hub", "rub", "sub", "tub"],
    "an": ["can", "fan", "man", "pan", "ran", "tan", "van"],
    "am": ["ham", "jam", "ram", "yam"],
    "ag": ["bag", "rag", "tag", "wag"],
    "un": ["bun", "fun", "gun", "run", "sun"],
    "ip": ["dip", "hip", "lip", "sip", "tip", "rip"],
    "ick": ["kick", "lick", "pick", "sick", "tick"],
    "ump": ["bump", "dump", "hump", "lump", "pump", "jump"],
    "amp": ["camp", "lamp", "stamp"],
    "and": ["hand", "sand", "land", "band"],
    "ink": ["sink", "think", "drink", "link", "wink", "pink"],
    "ank": ["bank", "tank", "sank", "rank"],
}
# 词族里的短元音 = rime 中第一个元音字母（不能取 k[0]，-ump/-and 首字母是辅音）
CVC_VOWEL = {k: next(c for c in k if c in "aeiou") for k in CVC}


def fv(word: str) -> str:
    """单词里第一个元音字母 —— 短元音题按单词本身取，不按词族取。"""
    return next((c for c in word if c in "aeiou"), "")


def rime(word: str) -> str:
    """韵脚 = 从第一个元音字母到词尾；两个词押韵 <=> rime 相同。"""
    i = min((word.find(v) for v in "aeiou" if v in word), default=-1)
    return word[i:] if i >= 0 else word

DIGRAPHS: dict[str, list[str]] = {
    "sh": ["ship", "shop", "sheep", "shell", "shoe", "shirt", "wash", "dish", "brush", "shine", "shape"],
    "ch": ["chat", "chip", "chin", "check", "cheese", "lunch", "beach", "much", "rich", "chick"],
    "th": ["thin", "thick", "bath", "math", "path", "thumb", "thank", "teeth", "cloth", "both"],
    "wh": ["what", "when", "where", "why", "which", "white", "wheel", "whip", "wheat", "whale"],
    "ck": ["duck", "chick", "sock", "rock", "kick", "neck", "back", "pack", "sack", "brick"],
    "ph": ["phone", "photo", "phonics", "graph"],
}
BLENDS: dict[str, list[str]] = {
    "bl": ["black", "blue", "block", "blink", "blend"],
    "br": ["brown", "bread", "brick", "brush", "bring", "broom", "brother"],
    "cl": ["clap", "clean", "clear", "clock", "close", "cloud", "class", "climb"],
    "pl": ["play", "plan", "plane", "plant", "plate", "plum", "plus"],
    "st": ["stop", "star", "step", "stick", "stone", "store", "stand", "stay"],
    "sp": ["spin", "spot", "spider", "spoon", "sport", "spill"],
    "dr": ["dress", "drop", "drum", "drive", "dream", "draw", "drip"],
    "tr": ["tree", "trip", "truck", "true", "train", "trick", "trust"],
}

# 闭音节 → 加不发音的 e 变长音（RF.1.3c）
MAGIC_E: list[tuple[str, str, str]] = [
    ("a", "cap", "cape"), ("a", "tap", "tape"), ("a", "hat", "hate"), ("a", "man", "mane"),
    ("i", "pin", "pine"), ("i", "kit", "kite"), ("i", "bit", "bite"), ("i", "hid", "hide"),
    ("o", "hop", "hope"), ("o", "not", "note"), ("o", "rob", "robe"),
    ("u", "cub", "cube"), ("u", "us", "use"),
]
VOWEL_TEAMS: dict[str, list[str]] = {
    "ee": ["see", "bee", "tree", "free", "three", "green", "sleep", "feet", "meet", "seed"],
    "ea": ["read", "sea", "eat", "meat", "leaf", "dream", "clean", "mean", "peak"],
    "oa": ["boat", "coat", "goat", "toad", "road", "soap", "foam", "oak"],
    "ai": ["rain", "train", "main", "pain", "nail", "mail", "tail", "wait"],
    "ay": ["play", "say", "day", "way", "may", "bay", "ray", "pray"],
    "igh": ["high", "light", "night", "right", "fight", "might", "tight"],
    "oe": ["toe", "shoe", "hoe"],
}
# 元音组合读哪个长元音（题干里说 sound 时用单字母名）
TEAM_VOWEL = {"ee": "e", "ea": "e", "oa": "o", "ai": "a", "ay": "a", "igh": "i", "oe": "o"}

DOLCH_PRIMER = [
    "he", "was", "that", "she", "on", "they", "but", "at", "with", "all", "there", "out",
    "be", "have", "am", "do", "did", "what", "so", "get", "like", "this", "will", "yes",
    "went", "are", "now", "no", "came", "ride", "into", "good", "want", "too", "pretty",
    "four", "saw", "well", "ran", "brown", "eat", "who", "new", "must", "black", "white",
    "soon", "our", "ate", "say", "under", "please",
]
DOLCH_G1 = [
    "after", "again", "an", "any", "as", "ask", "by", "could", "every", "fly", "from",
    "give", "going", "had", "has", "her", "him", "his", "how", "just", "know", "let",
    "live", "may", "of", "old", "once", "open", "over", "put", "round", "some", "stop",
    "take", "thank", "them", "then", "think", "walk", "were", "when",
]
FRY_100 = [
    "the", "of", "and", "a", "to", "in", "is", "you", "that", "it", "he", "was", "for",
    "on", "are", "as", "with", "his", "they", "I", "at", "be", "this", "have", "from",
    "or", "one", "had", "by", "words", "but", "not", "what", "all", "were", "we", "when",
    "your", "can", "said", "there", "use", "an", "each", "which", "she", "do", "how",
    "their", "if", "will", "up", "other", "about", "out", "many", "then", "them", "these",
    "so", "some", "her", "would", "make", "like", "him", "into", "time", "has", "look",
    "two", "more", "write", "go", "see", "number", "no", "way", "could", "people", "my",
    "than", "first", "water", "been", "called", "who", "am", "its", "now", "find", "long",
    "down", "day", "did", "get", "come", "made", "may", "part",
]
SIGHT = DOLCH_PRIMER + DOLCH_G1 + FRY_100

# 高频词完形填空：(题干, 正确答案, 干扰项)
CLOZE: list[tuple[str, str, list[str]]] = [
    ("I ___ a student.", "am", ["is", "are", "be"]),
    ("She ___ a red apple.", "has", ["have", "am", "are"]),
    ("We ___ happy today.", "are", ["is", "am", "do"]),
    ("He ___ to school every day.", "goes", ["go", "going", "gone"]),
    ("I see ___ elephant.", "an", ["two", "of", "many"]),
    ("Birds ___ in the sky.", "fly", ["swim", "dig", "knock"]),
    ("Fish live in the ___.", "water", ["sky", "tree", "shoe"]),
    ("I eat soup with a ___.", "spoon", ["ball", "hat", "door"]),
    ("We read ___ at school.", "books", ["balls", "shoes", "stars"]),
    ("What ___ your name?", "is", ["are", "am", "do"]),
    ("Thank you ___ your help.", "for", ["to", "at", "in"]),
    ("The sun is big and ___.", "hot", ["cold", "wet", "dark"]),
    ("Plants need water and ___.", "sun", ["milk", "shoes", "snow"]),
    ("I am six ___ old.", "years", ["cats", "cups", "cars"]),
    ("___ is my book? It is on the table.", "Where", ["What", "Who", "When"]),
    ("They ___ watching TV.", "are", ["is", "am", "does"]),
    ("I do not ___ where he went.", "know", ["no", "now", "new"]),
    ("We play ___ the playground.", "at", ["of", "to", "and"]),
    ("The cat is sleeping ___ the box.", "in", ["of", "to", "and"]),
    ("I like apples ___ oranges.", "and", ["of", "to", "at"]),
    ("He ___ his homework after school.", "does", ["do", "done", "doing"]),
    ("Can you ___ me your pen?", "give", ["say", "see", "go"]),
    ("We ___ our friends at school.", "see", ["eat", "drink", "sleep"]),
    ("My mother ___ me a goodnight kiss.", "gives", ["takes", "bakes", "drives"]),
]

PLURALS: list[tuple[str, str]] = [
    ("box", "boxes"), ("bus", "buses"), ("dish", "dishes"), ("watch", "watches"),
    ("brush", "brushes"), ("bench", "benches"), ("match", "matches"), ("fish", "fishes"),
    ("cat", "cats"), ("dog", "dogs"), ("bag", "bags"), ("pin", "pins"), ("cup", "cups"),
    ("ball", "balls"), ("car", "cars"), ("egg", "eggs"), ("wheel", "wheels"),
    ("hat", "hats"), ("shoe", "shoes"), ("jar", "jars"),
]
ING: list[tuple[str, str]] = [
    ("run", "running"), ("jump", "jumping"), ("sit", "sitting"), ("hop", "hopping"),
    ("clap", "clapping"), ("cry", "crying"), ("play", "playing"), ("make", "making"),
    ("take", "taking"), ("ride", "riding"), ("swim", "swimming"), ("sing", "singing"),
    ("dance", "dancing"), ("walk", "walking"), ("talk", "talking"), ("read", "reading"),
    ("draw", "drawing"), ("drive", "driving"), ("fly", "flying"), ("clean", "cleaning"),
]
ED: list[tuple[str, str]] = [
    ("walk", "walked"), ("jump", "jumped"), ("play", "played"), ("help", "helped"),
    ("look", "looked"), ("call", "called"), ("ask", "asked"), ("turn", "turned"),
    ("wash", "washed"), ("watch", "watched"), ("want", "wanted"), ("paint", "painted"),
    ("open", "opened"), ("close", "closed"), ("rake", "raked"), ("clean", "cleaned"),
]
UN_WORDS = ["undo", "untie", "unhappy", "unfair", "unkind", "unpack", "unfold",
            "unlucky", "untidy", "unplug", "unload", "unzip"]
RE_WORDS = ["redo", "remix", "replay", "return", "rewrite", "rebuild", "retell",
            "reheat", "refill", "rerun", "review", "replace"]

# L.1.5a 分类（连线题：词 → 类别）
CATEGORIES: list[tuple[str, list[str]]] = [
    ("an animal", ["dog", "cat", "pig", "cow"]),
    ("a color", ["red", "blue", "green", "pink"]),
    ("clothes", ["hat", "coat", "socks", "shoes"]),
    ("food", ["bread", "rice", "egg", "milk"]),
    ("weather", ["rain", "snow", "wind", "cloud"]),
    ("a body part", ["hand", "foot", "face", "ear"]),
    ("school things", ["book", "pen", "bag", "desk"]),
    ("family", ["mom", "dad", "sister", "brother"]),
]

NOUNS = ["dog", "school", "apple", "hand", "city", "book", "teacher", "car", "park", "milk"]
VERBS = ["run", "jump", "read", "sing", "eat", "play", "write", "fly", "swim", "help"]
ADJS = ["big", "red", "happy", "small", "hot", "kind", "old", "new"]

# L.1.2 大写与标点：(正确句, [三个错误写法])
SENTENCES_OK: list[tuple[str, list[str]]] = [
    ("I like my cat.", ["i like my cat.", "I like my Cat.", "i Like my cat."]),
    ("We go to school by bus.", ["we go to school by bus.", "We go to School by bus.", "We go to school bus."]),
    ("My name is Amy.", ["my name is Amy.", "My name is amy.", "My name Amy is."]),
    ("April fifth is my birthday.", ["april fifth is my birthday.", "April fifth is my Birthday.", "April fifth my is birthday."]),
    ("Do you like milk?", ["do you like milk?", "Do you like Milk?", "You do like milk."]),
    ("What a big dog!", ["what a big dog!", "What a big Dog!", "What a dog big!"]),
    ("Tom can swim fast.", ["tom can swim fast.", "Tom can Swim fast.", "Tom can fast swim."]),
    ("The sun is bright.", ["the sun is bright.", "Sun the is bright.", "The sun bright is."]),
    ("I see a rainbow.", ["i see a rainbow.", "I see a Rainbow.", "I a see rainbow."]),
    ("She lives in New York.", ["she lives in new york.", "She lives in New york.", "She lives york in New."]),
]
# 主谓一致 / 代词 / 时态 / 连词 / 介词（L.1.1c-e, L.1.1g-i）
GRAMMAR_CLOZE: list[tuple[str, str, list[str]]] = [
    ("He ___ tall.", "is", ["are", "am", "be"]),
    ("They ___ glad.", "are", ["is", "am", "was"]),
    ("You ___ my friend.", "are", ["is", "am", "does"]),
    ("It ___ a small cat.", "is", ["are", "am", "were"]),
    ("I ___ a boy.", "am", ["is", "are", "be"]),
    ("The dog ___ fast.", "runs", ["run", "are run", "runs to"]),
    ("We ___ to music.", "listen", ["listens", "listening to is", "listen of"]),
    ("Yesterday I ___ home.", "walked", ["walk", "will walk", "walks"]),
    ("Tomorrow we ___ a test.", "have", ["had", "having", "has"]),
    ("She can ___ a bike.", "ride", ["rides", "riding", "rode to"]),
    ("Give the book to ___.", "him", ["he", "his", "himself is"]),
    ("___ is my sister.", "She", ["Her", "Hers", "She is is"]),
    ("I like tea ___ coffee.", "and", ["because of a", "to", "of"]),
    ("The cat is ___ the table.", "under", ["of", "to", "and"]),
    ("This bag is ___.", "mine", ["my", "me", "I"]),
]

# 连词成句
ORDER_WORDS: list[list[str]] = [
    ["I", "have", "a", "big", "dog."],
    ["She", "can", "run", "very", "fast."],
    ["We", "like", "to", "eat", "apples."],
    ["The", "cat", "sat", "on", "the", "mat."],
    ["He", "goes", "to", "school", "by", "bus."],
    ["My", "mom", "cooks", "good", "food."],
    ["They", "are", "playing", "in", "the", "park."],
    ["Do", "you", "want", "some", "water?"],
    ["It", "is", "a", "sunny", "day."],
    ["Birds", "can", "fly", "in", "the", "sky."],
    ["I", "see", "a", "yellow", "star."],
    ["The", "dog", "has", "a", "small", "ball."],
    ["We", "read", "books", "every", "day."],
    ["She", "put", "the", "book", "on", "the", "table."],
    ["What", "is", "your", "favorite", "color?"],
    ["Let", "us", "go", "home", "now."],
]
# 故事排序（句子顺序）
ORDER_SENTENCES: list[list[str]] = [
    ["The seed grows.", "The flower opens.", "The bee comes."],
    ["I put on my coat.", "I go outside.", "I play in the snow."],
    ["Max digs a hole.", "He puts his bone in.", "He walks away."],
    ["Ana waters the cup.", "A shoot comes up.", "A leaf opens."],
    ["Tim hears the bell.", "He runs to the door.", "He opens it wide."],
    ["The hen lays an egg.", "A chick comes out.", "It pecks the ground."],
    ["We read the book.", "We talk about it.", "We draw a new end."],
    ["Sam eats his lunch.", "He packs his bag.", "He goes to bed."],
]

# 阅读理解短文（自编，公版级别的简单句）
PASSAGES: list[dict[str, Any]] = [
    {
        "text": "Max is a brown dog. He likes to run in the yard. Every morning he brings his ball to the door.",
        "detail": ("What color is Max?", "brown", ["white", "black", "red"], "The story says Max is a brown dog."),
        "cause": ("When does Max bring his ball to the door?", "every morning", ["at night", "after lunch", "on Sunday"], "The story says every morning he brings his ball."),
        "main": ("What is this story mostly about?", "a dog and his morning ball", ["a cat on a bed", "a bird in a tree", "a fish in a pond"], "All three sentences are about Max the dog and his ball."),
        "vocab": ("In the story, yard means ___.", "the ground next to a house", ["a place to buy milk", "a kind of ball", "a bed for a dog"], "A yard is the ground around a house."),
    },
    {
        "text": "Ana puts a seed in a cup. She sets the cup on the window. She gives it water every day. A green shoot comes up.",
        "detail": ("What does Ana put in the cup?", "a seed", ["a stone", "a coin", "an egg"], "Ana puts a seed in a cup."),
        "cause": ("Why does Ana give the cup water?", "so the seed can grow", ["so it stays clean", "so she can drink it", "so it gets warm"], "Water helps the seed grow; that is why a shoot comes up."),
        "main": ("What is this story about?", "a seed growing into a plant", ["a girl cleaning her room", "a cup lost at school", "a window in the rain"], "The story follows a seed that gets water and grows."),
        "vocab": ("In the story, a shoot is ___.", "the first green growth of a plant", ["a kind of cup", "the name for water", "a small stone"], "A shoot is the young green part that comes up."),
    },
    {
        "text": "The rain stops. Tim puts on his boots. He jumps in a big puddle. The water goes up, and he laughs.",
        "detail": ("What does Tim put on?", "his boots", ["his hat", "his shoes", "his coat"], "Tim puts on his boots."),
        "cause": ("Why does the water go up?", "because Tim jumps in it", ["because the rain comes back", "because Tim digs it", "because it is cold"], "He jumps in the puddle, so the water splashes up."),
        "main": ("What is this story mostly about?", "jumping in a puddle after rain", ["sleeping in the rain", "buying new boots", "walking to school"], "The story is about playing in a puddle when the rain stops."),
        "vocab": ("A puddle is ___.", "a small pool of water on the ground", ["a pair of boots", "a loud noise", "a kind of hat"], "A puddle is a little pool of water on the ground."),
    },
    {
        "text": "Mia has a red umbrella. It is windy. The umbrella turns up and flips. Mia laughs and runs home.",
        "detail": ("What color is Mia's umbrella?", "red", ["blue", "black", "pink"], "Mia has a red umbrella."),
        "cause": ("Why does the umbrella flip?", "because it is windy", ["because it is old", "because Mia runs fast", "because it rains hard"], "The wind turns the umbrella up so it flips."),
        "main": ("What is this story about?", "a windy day with an umbrella", ["a rainy day at school", "a new red coat", "Mia's lost bag"], "The umbrella flips because of the wind."),
        "vocab": ("Windy means ___.", "the air is moving a lot", ["the sky is dark", "it is very hot", "the ground is wet"], "Windy describes weather with moving air."),
    },
    {
        "text": "Ben finds a small bird under the bus. It cannot fly. Ben carries it to the grass. The bird hops away.",
        "detail": ("Where does Ben find the bird?", "under the bus", ["in a tree", "on his bed", "in the grass"], "Ben finds the bird under the bus."),
        "cause": ("Why does Ben carry the bird to the grass?", "because it cannot fly", ["because he is late", "because the bus is gone", "because it is hungry"], "The bird cannot fly, so Ben helps it to the grass."),
        "main": ("What is this story mostly about?", "a boy helping a small bird", ["a bus that is late", "a game in the grass", "a bird that can talk"], "The story is about Ben helping a bird that cannot fly."),
        "vocab": ("In the story, hops means ___.", "jumps on small feet", ["flies high", "swims fast", "sleeps deep"], "Birds hop; they take small jumps."),
    },
    {
        "text": "Sara and Sam share one cake. Sara cuts it in two. Sam takes the bigger piece, then gives the rest to Sara.",
        "detail": ("Who cuts the cake?", "Sara", ["Sam", "the teacher", "Mom"], "Sara cuts the cake in two."),
        "cause": ("Why can we say Sam is kind?", "he gives the rest to Sara", ["he eats the whole cake", "he cuts the cake", "he goes home"], "Sam gives the rest of his piece to Sara."),
        "main": ("What is this story about?", "two children sharing a cake", ["a birthday party at school", "a cake left in the oven", "Sara's new knife"], "The cake story is about sharing."),
        "vocab": ("Share means ___.", "to give part of something", ["to eat all by yourself", "to hide a cake", "to cook food"], "To share is to give part of what you have."),
    },
    {
        "text": "The moon is up. It looks like a banana. Tom draws the moon and the stars. He puts the paper on his wall.",
        "detail": ("What does the moon look like?", "a banana", ["a ball", "a boat", "a shoe"], "The story says the moon looks like a banana."),
        "cause": ("Why does Tom draw the moon?", "because it looks interesting", ["because his teacher says so", "because it is dark outside", "because he is lost"], "The shape of the moon makes Tom want to draw it."),
        "main": ("What is this story mostly about?", "a boy drawing the night sky", ["a boy eating a banana", "a walk to school", "a lost paper"], "Tom draws the moon and the stars."),
        "vocab": ("A wall is ___.", "the side of a room", ["a place to sleep", "a kind of light", "a drawing tool"], "A wall is the side of a room."),
    },
    {
        "text": "Cows live on the farm. They eat green grass. A farmer milks them twice a day. The milk goes to the store.",
        "detail": ("What do cows eat?", "green grass", ["red apples", "dry leaves", "white rice"], "The cows eat green grass."),
        "cause": ("Where does the milk go after the farm?", "to the store", ["to the moon", "to the river", "to the school"], "The last sentence says the milk goes to the store."),
        "main": ("What is this story about?", "milk coming from farm cows", ["a farmer's lost cow", "grass in the park", "a store full of toys"], "The story follows cows, milk, and where the milk goes."),
        "vocab": ("A farmer is the person who ___.", "takes care of farm animals", ["drives a school bus", "sells shoes", "fixes cars"], "A farmer works on a farm with the animals."),
    },
    {
        "text": "It is cold. Lily wears her coat, her hat, and her mittens. She makes a snowman with a carrot nose.",
        "detail": ("What is on the snowman's nose?", "a carrot", ["a stone", "a button", "a leaf"], "The snowman has a carrot nose."),
        "cause": ("Why does Lily wear mittens?", "because her hands are cold", ["because she is late", "because it is dark", "because she lost her gloves"], "It is cold, so mittens keep her hands warm."),
        "main": ("What is this story mostly about?", "making a snowman on a cold day", ["buying a new coat", "a lost carrot", "Lily's long walk home"], "Lily dresses for the cold and builds a snowman."),
        "vocab": ("Mittens are worn on the ___.", "hands", ["feet", "head", "back"], "Mittens keep your hands warm."),
    },
    {
        "text": "The class sees a caterpillar on the window. It eats a leaf. Two weeks later it is a butterfly and flies away.",
        "detail": ("What does the caterpillar eat?", "a leaf", ["a pen", "a crumb of bread", "a small stone"], "The caterpillar eats a leaf."),
        "cause": ("What happens two weeks later?", "it becomes a butterfly", ["it loses its tail", "it grows bigger leaves", "it comes back to the class"], "The story says that after two weeks it is a butterfly."),
        "main": ("What is this story about?", "a caterpillar turning into a butterfly", ["a class cleaning the window", "a leaf lost in the wind", "a butterfly that cannot fly"], "The story is about the change from caterpillar to butterfly."),
        "vocab": ("A caterpillar is ___.", "a small insect that looks like a worm", ["a big bird in a tree", "a kind of green leaf", "a cold day of rain"], "A caterpillar is the young, crawling stage of a butterfly."),
    },
    {
        "text": "Owen is late for school. He runs down the street. He forgets his bag at home and must walk back.",
        "detail": ("What does Owen forget?", "his bag", ["his shoe", "his key", "his hat"], "Owen forgets his bag at home."),
        "cause": ("Why must Owen walk back home?", "to get his bag", ["to feed his dog", "to find his shoe", "to meet his teacher"], "He left his bag at home, so he goes back for it."),
        "main": ("What is this story mostly about?", "a late morning before school", ["a long walk to the farm", "a new bag for school", "a game of tag"], "Everything in the story happens because Owen is late."),
        "vocab": ("If you are late, you are ___.", "not on time", ["very fast", "still asleep", "far away"], "Late means not on time."),
    },
    {
        "text": "Bees fly to the flowers. They take the sweet nectar home. Bees make honey in the hive for the winter.",
        "detail": ("Where do the bees fly?", "to the flowers", ["to the store", "to the river", "to the moon"], "The bees fly to the flowers."),
        "cause": ("Why do bees make honey?", "to have food in winter", ["to feed the birds", "to water the plants", "to warm the sun"], "The honey is made for the winter."),
        "main": ("What is this story about?", "bees making honey", ["flowers in a field", "a cold winter day", "a bird and a bee"], "The story explains how bees turn nectar into honey."),
        "vocab": ("A hive is the bees' ___.", "home", ["flower", "wing", "song"], "A hive is where bees live and make honey."),
    },
]

# ============================================================
# 单元 / 知识点元数据
# ============================================================


def kp(name: str, code: str, desc: str, difficulty: int, types: list[str]) -> dict[str, Any]:
    return {"name": name, "code": code, "desc": desc, "difficulty": difficulty, "types": types}


UNITS: list[dict[str, Any]] = [
    {
        "title": "字母与字母音 · Letters and Sounds",
        "kps": [
            kp("字母大小写", "RF.1.1, L.1.1a", "认识 26 个字母的大写与小写形式并互相配对。", 1, ["连线"]),
            kp("书写字母", "L.1.1a", "按提示写出对应的大写或小写字母，掌握字母表顺序。", 2, ["填空"]),
            kp("首音辨认", "RF.1.2c", "听/看单词，判断开头的音（initial sound）。", 1, ["选择"]),
            kp("尾音辨认", "RF.1.2c, RF.1.2d", "判断单词结尾的音（final sound）。", 2, ["选择"]),
            kp("长短音听辨", "RF.1.2a", "区分单音节词里的长元音与短元音。", 2, ["判断"]),
        ],
    },
    {
        "title": "短元音拼读 · Short Vowel CVC",
        "kps": [
            kp("词族认读", "RF.1.3b", "识别 -at / -og / -ump 等词族（word family）里的成员词。", 1, ["选择"]),
            kp("字母拼词", "RF.1.2d, RF.1.3b", "把打乱的字母排成正确的 CVC 单词。", 2, ["排序"]),
            kp("元音填空", "RF.1.2a, RF.1.3b", "根据词族补上缺少的短元音字母。", 2, ["填空"]),
            kp("押韵选词", "RF.1.3b", "找出与例词押韵（rhyme）的单词。", 2, ["选择"]),
            kp("短音判断", "RF.1.3b", "判断单词是否属于给定词族、读音是否正确。", 1, ["判断"]),
        ],
    },
    {
        "title": "辅音组合 · Blends and Digraphs",
        "kps": [
            kp("二合字母", "RF.1.3a", "识别 sh / ch / th / wh / ck / ph 二合字母的读音。", 1, ["选择"]),
            kp("连读辅音", "RF.1.2b", "识别 bl / br / cl / st / tr 等辅音连读（blend）。", 2, ["选择"]),
            kp("缺字母补全", "RF.1.3a", "补出单词里缺失的两个辅音字母。", 2, ["填空"]),
            kp("组合分类", "RF.1.3a", "把单词与它所含的辅音组合配对。", 2, ["连线"]),
            kp("读音判断", "RF.1.3a, RF.1.2b", "判断某词的辅音组合归类是否正确。", 1, ["判断"]),
        ],
    },
    {
        "title": "长元音与 Magic E · Long Vowels",
        "kps": [
            kp("e 让元音变长", "RF.1.3c", "词尾加不发音的 e，闭音节短元音变成长元音。", 1, ["选择"]),
            kp("元音组合", "RF.1.3c", "识别 ee / ea / oa / ai / ay / igh 等元音组合。", 2, ["选择"]),
            kp("开闭音节配对", "RF.1.3b, RF.1.3c", "把短元音词与对应的长元音词配对。", 2, ["连线"]),
            kp("长音拼写", "RF.1.3c, L.1.2d", "补出长元音单词里缺的字母组合。", 3, ["填空"]),
            kp("长音判断", "RF.1.2a", "判断单词中的元音是长音还是短音。", 2, ["判断"]),
        ],
    },
    {
        "title": "高频词与心词 · Sight Words",
        "kps": [
            kp("看字母选词", "RF.1.3g", "按拼写从形近词中认出目标高频词。", 2, ["选择"]),
            kp("句子选词填空", "RF.1.3g, L.1.4a", "在句子语境里选出正确的高频词。", 2, ["选择"]),
            kp("高频词拼写", "L.1.2d", "把句子里缺的高频词写出来。", 3, ["填空"]),
            kp("连词成句", "L.1.1j, RF.1.1a", "把打乱的单词排成语法正确的句子。", 3, ["排序"]),
            kp("拼写判断", "L.1.2d", "判断高频词的拼写是否正确。", 1, ["判断"]),
        ],
    },
    {
        "title": "词义与词形变化 · Meaning and Word Forms",
        "kps": [
            kp("复数形式", "L.1.1f", "规则复数加 -s，s/x/z/ch/sh 结尾加 -es。", 1, ["选择"]),
            kp("ing 和 ed 变化", "RF.1.3f, L.1.4c", "给动词加 -ing / -ed，注意双写与去 e。", 2, ["填空"]),
            kp("前缀 un 和 re", "L.1.4b", "用 un-（否定）与 re-（再做一次）推词义。", 2, ["选择"]),
            kp("词类分拣", "L.1.5a", "把单词按动物、颜色、衣物等类别归类。", 2, ["连线"]),
            kp("词义关系", "L.1.5b, L.1.5d", "按类别与关键特征解释词义，区分近义词。", 3, ["选择"]),
        ],
    },
    {
        "title": "句子与书写规范 · Sentences and Conventions",
        "kps": [
            kp("大写与标点", "L.1.2a, L.1.2b", "句首大写、专有名词大写、句末用对标点。", 2, ["选择"]),
            kp("排句成文", "L.1.1j", "把单词排成完整、正确的句子。", 3, ["排序"]),
            kp("名词与动词", "L.1.1b", "在词表里认出名词（人/地/物）与动词（动作）。", 1, ["选择"]),
            kp("代词与 be 动词", "L.1.1c, L.1.1d", "主格/所有格代词与 am / is / are 的搭配。", 2, ["选择"]),
            kp("句子判断", "RF.1.1a", "判断一句话的大写、标点或语序是否正确。", 1, ["判断"]),
        ],
    },
    {
        "title": "阅读理解 · Reading Comprehension",
        "kps": [
            kp("细节理解", "RL.1.1, RI.1.1", "从短文中找出 who / what / where / when 的答案。", 1, ["选择"]),
            kp("因果与顺序", "RL.1.1, RI.1.3", "判断事件之间的原因与先后顺序。", 2, ["选择"]),
            kp("主旨大意", "RL.1.2, RI.1.2", "说出短文主要在讲什么。", 3, ["选择"]),
            kp("词义猜测", "L.1.4a, RI.1.4", "借助句子语境猜出词义。", 3, ["选择"]),
            kp("故事排序", "W.1.3, RL.1.2", "把几句话按故事发生的先后排好。", 2, ["排序"]),
        ],
    },
]

# ============================================================
# 出题工具
# ============================================================

BARE_LETTER = re.compile(r"^[A-Da-d]$")


def _guard(options: list[str], answer: str) -> None:
    """choice 题的判分会把裸字母 A-D 当成选项序号，题库里必须避开。"""
    if BARE_LETTER.match(answer.strip()):
        raise ValueError(f"choice 答案不能是裸字母：{answer!r}")
    for o in options:
        if BARE_LETTER.match(o.strip()):
            raise ValueError(f"choice 选项不能是裸字母：{o!r}")


class QBank:
    def __init__(self, rng: random.Random) -> None:
        self.rng = rng
        self.by_kp: dict[str, list[dict[str, Any]]] = {}
        self.n = 0
        self._fill_q: dict[str, str] = {}

    def fill_unique(self, kp_name: str, question: str, answer: str, explanation: str,
                    *, score: int = 5, difficulty: int = 2) -> bool:
        """挖空题若题干相同而答案不同就会歧义（b___ 可能是 bee 也可能是 bay），冲突时放弃该题。"""
        prev = self._fill_q.get(question)
        if prev is not None and prev != answer:
            return False
        self._fill_q[question] = answer
        self.fill(kp_name, question, answer, explanation, score=score, difficulty=difficulty)
        return True

    def _add(self, kp_name: str, q: dict[str, Any]) -> None:
        self.n += 1
        q = {"id": self.n, "knowledge_point": kp_name, **q}
        self.by_kp.setdefault(kp_name, []).append(q)

    def choice(self, kp_name: str, question: str, answer: str, distractors: list[str],
               explanation: str, *, score: int = 5, difficulty: int = 1) -> None:
        opts = [answer] + distractors[:3]
        if len(opts) < 4:
            raise ValueError(f"选项不足 4 个：{question}")
        if len(set(opts)) != len(opts):
            raise ValueError(f"选项重复：{question} -> {opts}")
        self.rng.shuffle(opts)
        _guard(opts, answer)
        self._add(kp_name, {
            "type": "choice", "score": score, "difficulty": difficulty,
            "question": question, "options": opts, "answer": answer,
            "explanation": explanation,
        })

    def fill(self, kp_name: str, question: str, answer: str, explanation: str,
             *, score: int = 5, difficulty: int = 2) -> None:
        self._add(kp_name, {
            "type": "fill_blank_text", "score": score, "difficulty": difficulty,
            "question": question, "options": [], "answer": answer,
            "explanation": explanation,
        })

    def tf(self, kp_name: str, statement: str, ok: bool, explanation: str,
           *, score: int = 3, difficulty: int = 1) -> None:
        self._add(kp_name, {
            "type": "true_false", "score": score, "difficulty": difficulty,
            "question": statement, "options": [], "answer": "对" if ok else "错",
            "explanation": explanation,
        })

    def order(self, kp_name: str, question: str, words: list[str], explanation: str,
              *, score: int = 5, difficulty: int = 3) -> None:
        shuffled = list(words)
        self.rng.shuffle(shuffled)
        while shuffled == words:
            self.rng.shuffle(shuffled)
        self._add(kp_name, {
            "type": "word_order", "score": score, "difficulty": difficulty,
            "question": question, "options": shuffled, "answer": ",".join(words),
            "explanation": explanation,
        })

    def match(self, kp_name: str, question: str, pairs: list[tuple[str, str]],
              explanation: str, *, score: int = 5, difficulty: int = 2) -> None:
        left = [l for l, _ in pairs]
        right = [r for _, r in pairs]
        self.rng.shuffle(left)
        self.rng.shuffle(right)
        answer = ",".join(
            f"{'ABCD'[left.index(l)]}-{right.index(r) + 1}" for l, r in pairs
        )
        self._add(kp_name, {
            "type": "matching", "score": score, "difficulty": difficulty,
            "question": question, "options": left + right, "answer": answer,
            "explanation": explanation,
        })


def others(rng: random.Random, pool: list[str], answer: str, k: int = 3) -> list[str]:
    seen: dict[str, None] = {}
    for x in pool:
        if x != answer:
            seen.setdefault(x, None)
    cands = list(seen)
    rng.shuffle(cands)
    return cands[:k]


def mask(word: str, part: str) -> str:
    """把 word 里的 part 换成下划线，用于「缺字母」题。"""
    if part not in word:
        raise ValueError(f"{part!r} 不在 {word!r} 中")
    return word.replace(part, "___", 1)


# ============================================================
# 各单元出题
# ============================================================


def u1(bank: QBank, rng: random.Random) -> None:
    K = [k["name"] for k in UNITS[0]["kps"]]
    letters = list(LETTERS)
    rng.shuffle(letters)
    for group in [letters[i:i + 4] for i in range(0, 24, 4)]:
        bank.match(
            K[0], "Match each small letter with its big letter.",
            [(c, c.upper()) for c in sorted(group)],
            "The small letter and the big letter are two forms of the same letter.", difficulty=1,
        )

    for c in rng.sample(letters, 10):
        bank.fill(K[1], f"Write the big letter for '{c}'.", c.upper(),
                  f"The big form of '{c}' is '{c.upper()}'.", difficulty=1)
    for c in rng.sample(letters, 8):
        bank.fill(K[1], f"Write the small letter for '{c.upper()}'.", c,
                  f"The small form of '{c.upper()}' is '{c}'.", difficulty=1)
    for i in rng.sample(range(1, 25), 6):
        a, b, c = LETTERS[i - 1].upper(), LETTERS[i].upper(), LETTERS[i + 1].upper()
        bank.fill(K[1], f"Which letter comes between {a} and {c}?", b,
                  f"In the alphabet, {b} comes between {a} and {c}.", difficulty=2)

    all_cvc = [w for ws in CVC.values() for w in ws]
    for fam, words in list(CVC.items())[:14]:
        target = rng.choice(words)
        onset = target[0]
        bank.choice(
            K[2], f"Which word begins with the sound '{onset}'?", target,
            others(rng, [w for w in all_cvc if w[0] != onset], target),
            f"'{target}' begins with the sound {onset}.", difficulty=1,
        )
    for onset, words in list(BLENDS.items())[:6]:
        target = rng.choice(words)
        pool = [w for o, ws in BLENDS.items() if o != onset for w in ws] + all_cvc
        bank.choice(
            K[2], f"Which word begins with the blend '{onset}'?", target,
            others(rng, pool, target), f"'{target}' begins with {onset}.", difficulty=2,
        )

    finals = "tpnmdkrslo"
    for fin in finals:
        good = [w for w in all_cvc if w.endswith(fin)]
        if not good:
            continue
        target = rng.choice(good)
        bad = [w for w in all_cvc if not w.endswith(fin)]
        bank.choice(
            K[3], f"Which word ends with the sound '{fin}'?", target,
            others(rng, bad, target), f"'{target}' ends with the sound {fin}.", difficulty=2,
        )

    short = [(w, fv(w), True) for w in (rng.choice(ws) for f, ws in CVC.items())]
    long = [(w, v, False) for v, _, w in MAGIC_E] + [
        (rng.choice(ws), TEAM_VOWEL[t], False) for t, ws in VOWEL_TEAMS.items() if t != "oe"
    ]
    for w, v, is_short in rng.sample(short, 8) + rng.sample(long, 6):
        claim_short = rng.random() < 0.5
        kind = "short" if claim_short else "long"
        bank.tf(
            K[4], f"'{w}' has a {kind} {v} sound.", claim_short == is_short,
            f"'{w}' has the {'short' if is_short else 'long'} {v} sound.", difficulty=2,
        )


def u2(bank: QBank, rng: random.Random) -> None:
    K = [k["name"] for k in UNITS[1]["kps"]]
    fams = list(CVC.items())
    for _ in range(14):
        fam, words = rng.choice(fams)
        target = rng.choice(words)
        bad = [w for f, ws in fams if f != fam for w in ws]
        bank.choice(
            K[0], f"Which word is in the {fam} family?", target,
            others(rng, bad, target), f"'{target}' is in the {fam} word family.", difficulty=1,
        )
    for fam, words in rng.sample(fams, 10):
        outcast_pool = [w for f, ws in fams if f != fam for w in ws if not w.endswith(fam)]
        outcast = rng.choice(outcast_pool)
        kin = rng.sample(words, 3)
        bank.choice(
            K[0], f"Which word does NOT belong to the {fam} family?", outcast, kin,
            f"{', '.join(kin)} are in the {fam} family, but {outcast} is not.", difficulty=2,
        )

    all_cvc = [w for ws in CVC.values() for w in ws]
    for w in rng.sample(all_cvc, 16):
        letters = list(w)
        bank.order(
            K[1], f"Put the letters in order to make a word: {', '.join(letters)}.",
            letters, f"The word is {w}.", difficulty=2,
        )

    for fam, words in fams:
        for w in rng.sample(words, len(words)):
            v = fv(w)
            if bank.fill_unique(
                K[2], f"Fill in the missing vowel: {mask(w, v)}",
                v, f"{w} has the short {v} sound.", difficulty=2,
            ):
                break
        else:
            raise ValueError(f"{fam} 词族没有不歧义的挖空词")

    for fam, words in fams:
        target = rng.choice(words)
        same = [w for w in words if w != target and rime(w) == rime(target)]
        if not same:
            continue
        bad = [w for f, ws in fams if f != fam for w in ws if rime(w) != rime(target)]
        opts = [rng.choice(same)] + others(rng, bad, target)
        bank.choice(
            K[3], f"Which word rhymes with {target}?", opts[0], opts[1:],
            f"{opts[0]} and {target} rhyme - both end in {rime(target)}.", difficulty=2,
        )

    for _ in range(12):
        fam, words = rng.choice(fams)
        w = rng.choice(words)
        lie = rng.choice([f for f, _ in fams if f != fam])
        truth = rng.random() < 0.5
        shown = fam if truth else lie
        bank.tf(
            K[4], f"{w} belongs to the {shown} family.", truth,
            f"{w} belongs to the {fam} family.", difficulty=1,
        )


def u3(bank: QBank, rng: random.Random) -> None:
    K = [k["name"] for k in UNITS[2]["kps"]]
    all_dig = [w for ws in DIGRAPHS.values() for w in ws]
    all_blend = [w for ws in BLENDS.values() for w in ws]

    for dig, words in DIGRAPHS.items():
        # 干扰项必须真的不含该 digraph（"which" 同时含 wh/ch，不能当 ch 的反例）
        clean = [w for w in all_dig + all_blend if dig not in w]
        for _ in range(2):
            target = rng.choice(words)
            bank.choice(
                K[0], f"Which word has the {dig} sound?", target,
                others(rng, clean, target),
                f"{target} has the {dig} sound.", difficulty=1,
            )
    for blend, words in BLENDS.items():
        clean = [w for w in all_blend + all_dig if not w.startswith(blend)]
        for _ in range(2):
            target = rng.choice(words)
            bank.choice(
                K[1], f"Which word begins with the blend {blend}?", target,
                others(rng, clean, target),
                f"{target} begins with {blend}.", difficulty=2,
            )

    for dig, words in list(DIGRAPHS.items()):
        for w in rng.sample(words, len(words)):
            if bank.fill_unique(
                K[2], f"Which letters are missing? {mask(w, dig)}", dig,
                f"{w} starts with {dig}." if w.startswith(dig) else f"{w} has {dig}.",
                difficulty=2,
            ):
                break
    for blend, words in list(BLENDS.items()):
        for w in rng.sample(words, len(words)):
            if bank.fill_unique(
                K[2], f"Which letters are missing? {mask(w, blend)}", blend,
                f"{w} begins with {blend}.", difficulty=2,
            ):
                break

    picks = rng.sample(list(DIGRAPHS.items()), 4)
    bank.match(
        K[3], "Match each word with the two letters it uses.",
        [(rng.choice(ws), dg) for dg, ws in picks],
        "Each word is matched with the digraph inside it.", difficulty=2,
    )
    picks = rng.sample(list(BLENDS.items()), 4)
    bank.match(
        K[3], "Match each word with the blend it begins with.",
        [(rng.choice(ws), bl) for bl, ws in picks],
        "A blend keeps both letter sounds.", difficulty=2,
    )

    for _ in range(10):
        dg, ws = rng.choice(list(DIGRAPHS.items()))
        w = rng.choice(ws)
        others_dig = [d for d in DIGRAPHS if d != dg and d not in w]
        if not others_dig:
            continue
        lie = rng.choice(others_dig)
        truth = rng.random() < 0.5
        shown = dg if truth else lie
        bank.tf(
            K[4], f"{w} has the {shown} sound.", truth,
            f"{w} has the {dg} sound.", difficulty=1,
        )
    bank.tf(K[4], "who has the wh sound.", False,
            "who is an exception - it starts with the sound h.", difficulty=3)


def u4(bank: QBank, rng: random.Random) -> None:
    K = [k["name"] for k in UNITS[3]["kps"]]
    pool_long = [l for _, _, l in MAGIC_E] + [w for ws in VOWEL_TEAMS.values() for w in ws]
    pool_short = [w for ws in CVC.values() for w in ws]

    for v, closed, open_ in MAGIC_E:
        opts = [open_] + others(rng, pool_long + pool_short, open_)
        bank.choice(
            K[0], f"Add a silent e to {closed}. What is the new word?", open_, opts[1:],
            f"{closed} becomes {open_}, and the {v} becomes a long vowel sound.",
            difficulty=2,
        )

    team_words = [(t, w) for t, ws in VOWEL_TEAMS.items() for w in ws]
    for _ in range(14):
        team, target = rng.choice(team_words)
        bad = [w for t, w in team_words if t != team and team not in w]
        bank.choice(
            K[1], f"Which word uses the vowel team {team}?", target,
            others(rng, bad, target), f"{target} is spelled with {team}.", difficulty=2,
        )

    pairs4 = rng.sample(MAGIC_E, 4)
    bank.match(
        K[2], "Match each short-vowel word with its long-vowel word.",
        [(c, o) for _, c, o in pairs4],
        "Adding a silent e makes the vowel long.", difficulty=2,
    )
    bank.match(
        K[2], "Match each word with the vowel sound you hear.",
        [("hat", "short a"), ("cake", "long a"), ("bed", "short e"), ("tree", "long e")],
        "hat and bed have short vowels; cake and tree have long vowels.", difficulty=2,
    )

    for team, words in VOWEL_TEAMS.items():
        made = 0
        for w in rng.sample(words, len(words)):
            if made >= 2:
                break
            if bank.fill_unique(
                K[3], f"Which letters are missing? {mask(w, team)}", team,
                f"{w} uses the vowel team {team}.", difficulty=3, score=5,
            ):
                made += 1

    long_words = [(w, v) for v, _, w in MAGIC_E]
    for _ in range(8):
        w, v = rng.choice(long_words)
        bank.tf(K[4], f"{w} has a long {v} sound.", True,
                f"The silent e makes the {v} long in {w}.", difficulty=1)
    for _ in range(8):
        fam = rng.choice(list(CVC.items()))
        w = rng.choice(fam[1])
        v = fv(w)
        bank.tf(K[4], f"{w} has a long {v} sound.", False,
                f"{w} has the short {v} sound.", difficulty=2)


def u5(bank: QBank, rng: random.Random) -> None:
    K = [k["name"] for k in UNITS[4]["kps"]]
    lookalike = {
        "was": ["saw", "war", "wax"], "saw": ["was", "sea", "so"],
        "there": ["where", "three", "these"], "here": ["three", "where", "share"],
        "then": ["them", "than", "when"], "them": ["then", "they", "theme"],
        "from": ["form", "for", "front"], "into": ["onto", "into", "under"],
        "come": ["came", "some", "home"],
        "walk": ["work", "way", "will"], "want": ["went", "well", "will"],
        "were": ["where", "wear", "wet"], "when": ["were", "what", "who"],
        "know": ["no", "now", "new"], "thought": ["though", "through", "third"],
        "little": ["letter", "later", "ladder"], "people": ["please", "power", "paper"],
        "because": ["before", "behind", "between"], "school": ["shape", "shoe", "ship"],
        "friend": ["front", "from", "first"], "money": ["monkey", "many", "funny"],
    }
    for w, ds in lookalike.items():
        # 干扰项优先用形近词，凑不够 3 个再补高频词
        pool = [d for d in ds if d != w]
        pool += others(rng, [x for x in SIGHT if x != w and x not in pool], w, 3 - len(pool))
        bank.choice(
            K[0], f"Read the letters. Which word is {w}?", w, pool,
            f"{w} is spelled {', '.join(w)}.", difficulty=2,
        )

    for sent, ans, ds in CLOZE:
        bank.choice(K[1], f"Choose the word that fits: {sent}", ans, ds,
                    f"The sentence is: {sent.replace('___', ans)}", difficulty=2)

    for sent, ans, _ in CLOZE:
        bank.fill(K[2], f"Write the missing word: {sent}", ans,
                  f"{sent.replace('___', ans)}", difficulty=3)

    for words in ORDER_WORDS:
        bank.order(K[3], "Put the words in order to make a sentence.", words,
                   " ".join(words), difficulty=3)

    for _ in range(14):
        w = rng.choice(SIGHT)
        truth = rng.random() < 0.5
        shown = w if truth else _misspell(rng, w)
        bank.tf(K[4], f"The word is spelled {shown}.", truth,
                f"The correct spelling is {w}.", difficulty=2)


def _misspell(rng: random.Random, w: str) -> str:
    """造一个明显错的拼写：换字母 / 少字母 / 倒序两字母。"""
    for _ in range(20):
        i = rng.randrange(len(w))
        if len(w) > 3 and rng.random() < 0.4:
            cand = w[:i] + w[i + 1:]
        else:
            cand = w[:i] + rng.choice("aeiouylnst") + w[i + 1:]
        if cand != w and cand not in SIGHT:
            return cand
    raise ValueError(f"无法为 {w!r} 造出错误拼写")


def u6(bank: QBank, rng: random.Random) -> None:
    K = [k["name"] for k in UNITS[5]["kps"]]
    all_plural = [p for _, p in PLURALS]
    for sing, plur in PLURALS:
        bad = others(rng, [w for w in all_plural + [sing + "s", sing + "es", sing] if w != plur], plur)
        bank.choice(
            K[0], f"What is the plural of {sing}?", plur, bad,
            f"{sing} becomes {plur}.", difficulty=1,
        )

    for base, form in ING:
        bank.fill(K[1], f"Write the -ing form of {base}.", form,
                  f"{base} becomes {form} with -ing.", difficulty=2)
    for base, form in ED:
        bank.fill(K[1], f"Write the -ed form of {base}.", form,
                  f"{base} becomes {form} with -ed.", difficulty=2)

    for w in UN_WORDS:
        base = w[2:]
        bank.choice(
            K[2], f"un- means not. What does {w} mean?", f"not {base}",
            others(rng, [f"again {base}", f"very {base}", f"before {base}"], f"not {base}"),
            f"un{base} = not {base}.", difficulty=2,
        )
    for w in RE_WORDS:
        base = w[2:]
        bank.choice(
            K[2], f"re- means again. What does {w} mean?", f"do {base} again",
            others(rng, [f"not {base}", f"very {base}", f"anti {base}"], f"do {base} again"),
            f"re{base} = do {base} again.", difficulty=2,
        )

    for i in range(0, len(CATEGORIES), 4):
        group = CATEGORIES[i:i + 4]
        if len(group) < 4:
            continue
        bank.match(
            K[3], "Match each word with its category.",
            [(rng.choice(words), cat) for cat, words in group],
            "Sorting words into groups helps you remember them.", difficulty=2,
        )

    meaning = [
        ("A duck is a bird that ___.", "swims", ["flies high", "barks", "digs holes"]),
        ("A tiger is a large cat with ___.", "stripes", ["wings", "scales", "horns"]),
        ("If you are exhausted, you are ___.", "very tired", ["very hungry", "very cold", "very fast"]),
        ("If you whisper, you speak ___.", "very quietly", ["very loudly", "angrily", "in your sleep"]),
        ("A peek is a ___ look.", "quick", ["long", "loud", "sweet"]),
        ("A giant is much ___ than a boy.", "larger", ["smaller", "quieter", "older"]),
        ("A cozy room is a ___ room.", "warm and comfortable", ["very empty", "very dark", "very cold"]),
        ("When you giggle, you ___.", "laugh in a short way", ["cry loudly", "run fast", "fall asleep"]),
    ]
    for q, a, ds in meaning:
        bank.choice(K[4], q, a, ds, f"{q.replace('___', a)}", difficulty=3)


def u7(bank: QBank, rng: random.Random) -> None:
    K = [k["name"] for k in UNITS[6]["kps"]]
    for good, bads in SENTENCES_OK:
        bank.choice(
            K[0], "Which sentence is written correctly?", good, bads,
            f"{good} starts with a capital letter and ends with the right mark.",
            difficulty=2,
        )
    for words in rng.sample(ORDER_WORDS, 12):
        bank.order(K[1], "Put the words in order to make a sentence.", words,
                   " ".join(words), difficulty=3)
    for words in rng.sample(ORDER_SENTENCES, 6):
        bank.order(K[1], "Put the sentences in the right order.", words,
                   " ".join(words), difficulty=3)

    for w in rng.sample(NOUNS, 10):
        bank.choice(K[2], "Which word is a noun (a person, place, or thing)?", w,
                    others(rng, VERBS + ADJS, w), f"{w} names a thing - it is a noun.", difficulty=1)
    for w in rng.sample(VERBS, 8):
        bank.choice(K[2], "Which word is a verb (an action)?", w,
                    others(rng, NOUNS + ADJS, w), f"{w} is an action, so it is a verb.", difficulty=2)

    for sent, ans, ds in GRAMMAR_CLOZE:
        bank.choice(K[3], f"Choose the right word: {sent}", ans, ds,
                    f"The sentence is: {sent.replace('___', ans)}", difficulty=2)

    checks = [
        ("The sentence 'i like my cat.' is written correctly.", False,
         "The word I is always capitalized, and the first word of a sentence starts big."),
        ("A sentence ends with a period, a question mark, or an exclamation mark.", True,
         "Those are the three end marks."),
        ("The word 'every' is a verb.", False, "every is not an action word."),
        ("In the sentence 'We hop', the verb is correct.", True, "We hop, but he hops."),
        ("Mom and April are proper nouns, so they start with a capital letter.", True,
         "Names of people and months are proper nouns."),
        ("The word 'book' is a noun.", True, "book names a thing."),
        ("The word 'under' is a verb.", False, "under is a preposition, not an action."),
        ("The word 'ran' is a past-tense verb.", True, "Yesterday I ran."),
        ("You should write 'my name is ann' as 'My name is Ann.'", True,
         "Capitalize the first word and both names."),
        ("The word 'big' is an adjective.", True, "big describes a noun."),
    ]
    for stmt, ok, why in checks:
        bank.tf(K[4], stmt, ok, why, difficulty=2)


def u8(bank: QBank, rng: random.Random) -> None:
    K = [k["name"] for k in UNITS[7]["kps"]]
    for p in PASSAGES:
        stem = f"Read: {p['text']} "
        for key, idx in (("detail", 0), ("cause", 1), ("main", 2), ("vocab", 3)):
            q, ans, ds, why = p[key]
            if len(ds) < 3:
                ds = list(ds) + others(rng, SIGHT + NOUNS, ans, 3 - len(ds))
            bank.choice(K[idx], f"{stem}{q}", ans, ds[:3], f"{p['text']} {why}", difficulty=2)
    for words in ORDER_SENTENCES:
        bank.order(K[4], "Put the sentences in story order.", words, " ".join(words),
                   difficulty=2)


UNIT_BUILDERS = [u1, u2, u3, u4, u5, u6, u7, u8]

# ============================================================
# knowledge_summary 文案
# ============================================================

# 每个知识点的「一句话规则」+「两个常见错误」，中文（走系统中文朗读）
KP_NOTES: dict[str, tuple[str, list[str]]] = {
    "字母大小写": ("一个大写一个小写是同一个字母的两种写法。", ["把 b 看成 d、p 看成 q", "忘记 M/N 与 W/V 的小写形式"]),
    "书写字母": ("字母表顺序固定：A B C D …，前后字母要背熟。", ["只背唱名，说不出相邻字母", "大小写混着写"]),
    "首音辨认": ("initial sound 就是单词最开头的那个音，不是字母名。", ["把字母名 /siː/ 当成音 /s/", "看到 ch 拆成 c + h 两个音"]),
    "尾音辨认": ("final sound 看单词最后一个音，注意词尾不发音的 e。", ["把 -ed 读成两个音", "忽略词尾辅音连读里的第二个音"]),
    "长短音听辨": ("长元音念字母本音（cake 的 a），短元音念短音（cat 的 a）。", ["看到 a 一律读短音", "把元音组合当成两个音"]),
    "词族认读": ("词族 = 韵脚相同的词，-at 族有 cat / hat / sat。", ["以为结尾字母相同就同族（lamp 不属于 -ump）", "把视觉相似词归错族"]),
    "字母拼词": ("先读出每个字母，再按从左到右拼回单词。", ["打乱后只记首尾字母", "双写音被漏掉，如 ump 少写 m"]),
    "元音填空": ("CVC 词中间只有一个元音字母，a e i o u 五选一。", ["用词族默认元音套所有词", "把 y 当成 a e i o u 之一"]),
    "押韵选词": ("押韵看韵脚：从第一个元音到词尾要完全相同。", ["只看结尾一个字母", "把 think / bank 当成押韵"]),
    "短音判断": ("闭音节（辅音收尾）里的元音一般读短音。", ["把词族名和读音混为一谈", "见到 -ck 就以为元音变长"]),
    "二合字母": ("sh / ch / th / wh / ck / ph 两个字母只发一个音。", ["把 digraph 拆成两个音", "wh 与 who 例外：who 读 /h/"]),
    "连读辅音": ("blend 里两个辅音都保留自己的音：bl = b + l。", ["把 blend 当成 digraph", "漏读 blend 里的 l 或 r"]),
    "缺字母补全": ("先读出整词，再补出缺的那两个字母。", ["补成读音相近的另一组（sh 写成 s）", "把大写位置留空"]),
    "组合分类": ("按词里真正听到的那个音归类，而不是看字母多不多。", ["一词含两个组合时选错（which 含 wh 和 ch）", "把词首 / 词中位置当成分类依据"]),
    "读音判断": ("判断前先默读一遍，再看描述是否与实际一致。", ["凭印象判断，不拼读", "把例外词当成规则词"]),
    "e 让元音变长": ("词尾加不发音的 e，前面的元音读字母本音：cap → cape。", ["把词尾 e 也读出来", "忘记同时改变元音长度"]),
    "元音组合": ("两个元音手拉手，通常只发第一个的长音：ee / ea / oa / ai。", ["挨个读两个元音字母", "igh 读成 i + g + h"]),
    "开闭音节配对": ("闭音节 + e = 开音节，成对记忆：hop / hope。", ["配对时只看首字母", "把 not / note 顺序写反"]),
    "长音拼写": ("听到长音却只写一个字母时，想想是不是漏了组合。", ["用同音的不同组合（ai 写成 ea）", "漏掉词尾 e"]),
    "长音判断": ("元音后面紧跟辅音多为短音，词尾有 e 或用组合多为长音。", ["把长音词误判为短音", "被同形词族干扰"]),
    "看字母选词": ("逐字母比对，别整词扫读：was / saw / war 字母一样顺序不同。", ["只看首字母就作答", "把形近词当成同一个词"]),
    "句子选词填空": ("先读懂句子意思，再按语法搭配选词（I am / He goes）。", ["只按词频选最常见的词", "忽略主谓一致"]),
    "高频词拼写": ("心词不符合拼读规则，要整体记住字母顺序。", ["按读音拼写（them 写成 dem）", "多写字母或漏写字母"]),
    "连词成句": ("先找开头大写的词，句末带标点的词放最后。", ["把带句号的词放中间", "忘了句首要大写"]),
    "拼写判断": ("对照见过的样子逐字母检查，尤其词尾。", ["把 -er / -re 顺序看反", "漏掉双写字母"]),
    "复数形式": ("一般加 -s；s / x / z / ch / sh 结尾加 -es。", ["watch 写成 watchs", "把不规则变化（feet）当成规则"]),
    "ing 和 ed 变化": ("重读闭音节要双写尾字母再加 -ing（run → running）。", ["sit 写成 sitting 时漏双写", "去 e 加 ing 时把 e 保留（danceing）"]),
    "前缀 un 和 re": ("un- = not（没有），re- = again（再做一次）。", ["把 re- 当成否定", "去掉前缀后拼错词根"]),
    "词类分拣": ("问自己：这是动物、颜色、还是穿在身上的？", ["按首字母而不是词义分类", "一词多义时选错类别"]),
    "词义关系": ("用类别加关键特征解释词：duck 是会游泳的鸟。", ["只说外形不说类别", "把反义词当成同类词"]),
    "大写与标点": ("句首、专有名词、单词 I 要大写；问句用 ?，感叹用 !。", ["普通名词也大写", "陈述句写成问号"]),
    "排句成文": ("按 谁 + 做 + 什么 的顺序排，最后检查标点。", ["把修饰词插在动词中间", "句末词漏掉标点"]),
    "名词与动词": ("名词是人和事物，动词是动作；能加 a / the 的多是名词。", ["把 -ing 结尾的名词当动词", "同时是名 / 动词时选错"]),
    "代词与 be 动词": ("I am / He is / They are；所有格用 my / his / their。", ["用 him 作主语", "are 配第三人称单数"]),
    "句子判断": ("看三件事：首字母、专有名词、句末标点。", ["只看单词拼写", "忽略问句要用问号"]),
    "细节理解": ("答案一定在原文里，回原文找同一个词或换说法的句子。", ["凭记忆作答不回看", "把相似细节混用"]),
    "因果与顺序": ("because 回答为什么，then / next 表示接下来。", ["把时间先后当成原因", "选原文没提到的理由"]),
    "主旨大意": ("想「整篇主要在说谁、说什么事」，不要只盯一句话。", ["选只覆盖细节的选项", "加入自己想象的内容"]),
    "词义猜测": ("用同句的线索：举例、对比、重复出现的动作。", ["脱离句子按字母猜", "把生词读成形近熟词"]),
    "故事排序": ("找起点（谁在哪里），再看接下来发生了什么，最后是结果。", ["把结尾句放在开头", "忽略表示顺序的连接词"]),
}

# 各题型作答步骤（中文，与题型一一对应）
TYPE_STEPS = {
    "连线": "看左边 → 想配对 → 点右边",
    "填空": "读题干 → 想拼写 → 打字作答",
    "选择": "先听读音 / 看拼写 → 再排除 → 选答案",
    "排序": "先找第一个 → 依次点击 → 连成整句",
    "判断": "先默读一遍 → 对照规则 → 判对错",
}


def summary_for(meta: dict[str, Any]) -> dict[str, Any]:
    rule, mistakes = KP_NOTES[meta["name"]]
    return {
        "point": meta["name"],
        "core_concept": f"{meta['desc']}（对应标准 {meta['code']}）",
        "key_formula": rule,
        "common_mistakes": mistakes,
        "tips": f"{TYPE_STEPS[meta['types'][0]]}；生词先跟读两遍再做题，错题自动进错题本。",
    }


def build_book(book_key: str) -> None:
    rng = random.Random(f"ela-{book_key}")
    outline: dict[str, Any] = {"textbook": TEXTBOOK, "units": []}

    for u_idx, unit in enumerate(UNITS, start=1):
        bank = QBank(rng)
        UNIT_BUILDERS[u_idx - 1](bank, rng)
        kp_names = [k["name"] for k in unit["kps"]]

        unit_test: list[dict[str, Any]] = []
        exam: list[dict[str, Any]] = []
        kps: list[dict[str, Any]] = []
        summaries: list[dict[str, Any]] = []

        for name in kp_names:
            qs = bank.by_kp.get(name, [])
            if not qs:
                continue
            meta = next(k for k in unit["kps"] if k["name"] == name)
            kps.append({
                "name": name,
                "description": meta["desc"],
                "difficulty": meta["difficulty"],
                "question_types": meta["types"],
            })
            summaries.append(summary_for(meta))
            unit_test.extend(qs)
            exam.extend(rng.sample(qs, min(len(qs), 3)))

        mixed = unit_test[:]
        rng.shuffle(mixed)
        for q in mixed:
            if len(exam) >= 15:
                break
            if q not in exam:
                exam.append(dict(q))

        outline["units"].append({"unit_number": u_idx, "title": unit["title"], "knowledge_points": kps})
        quiz = {
            "textbook": TEXTBOOK,
            "unit": unit["title"],
            "unit_number": u_idx,
            "unit_test": {
                "title": f"Unit {u_idx}「{unit['title']}」英文练习",
                "total_score": 100,
                "time_minutes": 20,
                "questions": unit_test,
            },
            "exam": {
                "title": f"Unit {u_idx}「{unit['title']}」综合挑战",
                "total_score": 100,
                "time_minutes": 15,
                "questions": exam[:15],
            },
            "knowledge_summary": summaries,
        }
        QUIZ_DIR.mkdir(parents=True, exist_ok=True)
        (QUIZ_DIR / f"{STEM}_unit{u_idx}.json").write_text(
            json.dumps(quiz, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"  Unit {u_idx}: {len(unit_test)} 题 / {len(kps)} 知识点")

    OUTLINE_DIR.mkdir(parents=True, exist_ok=True)
    (OUTLINE_DIR / f"{STEM}.json").write_text(
        json.dumps(outline, ensure_ascii=False, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    missing = [k["name"] for u in UNITS for k in u["kps"] if k["name"] not in KP_NOTES]
    if missing:
        raise SystemExit(f"KP_NOTES 缺文案：{missing}")
    build_book("g1up")
    print("✅ output/ela 生成完成")
