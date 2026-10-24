import test from "node:test";
import assert from "node:assert/strict";
import {
    ansiToHtml,
    ansiStyles,
    applyAnsiColors,
} from "../../src/common/ansi.ts";
import { readFileSync } from "node:fs";

test("ANSI log rendering escapes HTML and uses fixed CSS classes", () => {
    assert.equal(
        ansiToHtml("<script>&\"'</script>"),
        "&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;",
    );
    assert.equal(
        ansiToHtml("\x1b[1;31m<img src=x onerror=alert(1)>\x1b[0m plain"),
        '<span class="ansi-bold ansi-fg-1">&lt;img src=x onerror=alert(1)&gt;</span> plain',
    );
    for (let index = 0; index < 16; index++) {
        const fg = index < 8 ? 30 + index : 90 + index - 8;
        const bg = index < 8 ? 40 + index : 100 + index - 8;
        assert.equal(
            ansiToHtml(`\x1b[${fg};${bg}mcolor`),
            `<span class="ansi-fg-${index} ansi-bg-${index}">color</span>`,
        );
        assert.ok(ansiStyles.includes(`.ansi-fg-${index}{`));
        assert.ok(ansiStyles.includes(`.ansi-bg-${index}{`));
    }
});

test("ANSI log rendering handles selective resets and incomplete snapshots", () => {
    assert.equal(
        ansiToHtml("\x1b[1;31;44mA\x1b[22;39mB\x1b[49mC"),
        '<span class="ansi-bold ansi-fg-1 ansi-bg-4">A</span><span class="ansi-bg-4">B</span>C',
    );
    assert.equal(ansiToHtml("start\x1b[3"), "start");
    assert.equal(
        ansiToHtml("start\x1b[31mred\x1b["),
        'start<span class="ansi-fg-1">red</span>',
    );
    assert.equal(
        ansiToHtml("start\x1b[31mred\x1b[mend"),
        'start<span class="ansi-fg-1">red</span>end',
    );
});

test("ANSI log rendering discards unsupported controls", () => {
    assert.equal(
        ansiToHtml(
            "\x1b[2Jtext\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x07",
        ),
        "textlink",
    );
    assert.equal(ansiToHtml("text\x1b]unfinished title"), "text");
    assert.equal(
        ansiToHtml("\x1b[38;2;0;0;0;1;32mgreen"),
        '<span class="ansi-bold ansi-fg-2">green</span>',
    );
});

test("ANSI extended colors preserve palette boundaries and exact RGB", () => {
    for (const [index, hex] of [
        [16, "#000000"],
        [21, "#0000ff"],
        [196, "#ff0000"],
        [231, "#ffffff"],
        [232, "#080808"],
        [255, "#eeeeee"],
    ] as const) {
        assert.equal(
            ansiToHtml(`\x1b[38;5;${index};48;5;${index}mcolor`),
            `<span data-ansi-fg="${hex}" data-ansi-bg="${hex}">color</span>`,
        );
    }
    assert.equal(
        ansiToHtml(
            "\x1b[1;38;2;12;34;56;48;2;255;0;128mRGB\x1b[39;49;22m plain",
        ),
        '<span class="ansi-bold" data-ansi-fg="#0c2238" data-ansi-bg="#ff0080">RGB</span> plain',
    );
});

test("ANSI extended colors accept colon forms and reject malformed values safely", () => {
    for (const code of [
        "38:2:12:34:56",
        "38:2::12:34:56",
        "38:2:0:12:34:56",
        "38;2;12;34;56",
    ]) {
        assert.equal(
            ansiToHtml(`\x1b[${code}m<text>`),
            '<span data-ansi-fg="#0c2238">&lt;text&gt;</span>',
        );
    }
    assert.equal(
        ansiToHtml("\x1b[38:5:196;48:2::0:1:2mtext"),
        '<span data-ansi-fg="#ff0000" data-ansi-bg="#000102">text</span>',
    );
    for (const code of [
        "38;5;256",
        "38;5;",
        "38;2;256;0;0",
        "38;2;1;2",
        "38;2;;1;2",
        "38:2:1:12:34:56",
        "38:5:999",
        "58;2;0;255;0",
    ]) {
        assert.equal(ansiToHtml(`\x1b[${code}mtext`), "text");
    }
    assert.equal(
        ansiToHtml("\x1b[31mred\x1b[38;5;999mstill red"),
        '<span class="ansi-fg-1">red</span><span class="ansi-fg-1">still red</span>',
    );
    assert.equal(ansiToHtml("text\x1b[38;2;12;"), "text");
});

test("ANSI RGB rendering assigns only validated CSS properties", () => {
    const spans = [
        {
            dataset: { ansiFg: "#0c2238", ansiBg: "#ff0080" },
            style: {} as Record<string, string>,
        },
        {
            dataset: { ansiFg: "url(evil)", ansiBg: "#fff; color:red" },
            style: {} as Record<string, string>,
        },
    ];
    const root = { querySelectorAll: () => spans } as unknown as HTMLElement;
    applyAnsiColors(root);
    assert.deepEqual(spans[0]!.style, {
        color: "#0c2238",
        backgroundColor: "#ff0080",
    });
    assert.deepEqual(spans[1]!.style, {});
    const styles = readFileSync(
        new URL("../../public/styles.css", import.meta.url),
        "utf8",
    );
    assert.ok(
        styles.replace(/\s+/g, "").replace(/;}/g, "}").includes(ansiStyles),
    );
});
