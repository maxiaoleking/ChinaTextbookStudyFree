#!/usr/bin/env python3
"""Exercise the real container's routes, resource JSON, images and MP3 range requests."""
import argparse
import json
import re
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="http://127.0.0.1:8080")
    args = parser.parse_args()
    origin = args.origin.rstrip("/")
    checks = []

    def fetch(path, expected=200, content_type=None, headers=None):
        request = urllib.request.Request(origin + path, headers=headers or {})
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            assert response.status == expected, (path, response.status)
            if content_type:
                assert response.headers.get_content_type() == content_type, (path, dict(response.headers))
            result = response.read()
            checks.append(path)
            return result, response.headers

    fetch("/healthz", content_type="text/plain")
    home, _ = fetch("/", content_type="text/html")
    css = re.search(rb'href="([^" ]+\.css[^" ]*)"', home)
    assert css, "Home page has no stylesheet"
    fetch(css.group(1).decode(), content_type="text/css")
    for path in ("/grade/2/", "/book/g6up/", "/lesson/g6up/g6up-u1-kp2/",
                 "/lesson/g6up/g6up-u1-exam/", "/reading/chinese-g2up/",
                 "/stories/chinese-g2up/", "/profile/", "/review/", "/shop/"):
        fetch(path, content_type="text/html")

    raw, _ = fetch("/data/books/g6up/lessons/g6up-u1-kp2.json", content_type="application/json")
    lesson = json.loads(raw)
    question = next(q for q in lesson["questions"] if q["id"] == 9)
    assert question["options"][1] == question["answer"] == "a < b"
    audio = question["audio"]["question"]
    assert audio.endswith(".mp3"), audio
    audio_bytes, _ = fetch(audio, content_type="audio/mpeg")
    partial, headers = fetch(audio, expected=206, content_type="audio/mpeg", headers={"Range": "bytes=0-31"})
    assert partial == audio_bytes[:32]
    assert headers["Content-Range"] == f"bytes 0-31/{len(audio_bytes)}"
    assert audio_bytes.startswith(b"ID3") or (audio_bytes[0] == 255 and audio_bytes[1] & 224 == 224)

    raw, _ = fetch("/data/books/chinese-g2up/stories.json", content_type="application/json")
    stories = json.loads(raw)["stories"]
    story = next(s for s in stories if s.get("image"))
    fetch(story["image"], content_type="image/jpeg")
    fetch(f'/stories/chinese-g2up/{story["id"]}/', content_type="text/html")
    fetch("/missing-issue-test/", expected=404, content_type="text/html")
    fetch("/.env", expected=404)
    print(json.dumps({"status": "passed", "checks": len(checks), "origin": origin,
                      "audio": audio, "range_bytes": len(partial)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
