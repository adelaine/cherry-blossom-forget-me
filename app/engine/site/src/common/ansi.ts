// Escape untrusted output before adding the limited ANSI formatting markup.
export const ansiToHtml = (input: string): string => {
    let foreground: number | string | undefined;
    let background: number | string | undefined;
    let bold = false;
    let output = "";
    const emit = (text: string) => {
        const escaped = text.replace(
            /[&<>"']/g,
            (character) =>
                ({
                    "&": "&amp;",
                    "<": "&lt;",
                    ">": "&gt;",
                    '"': "&quot;",
                    "'": "&#39;",
                })[character]!,
        );
        if (!escaped) return;
        const classes = [
            bold ? "ansi-bold" : "",
            typeof foreground === "number" ? `ansi-fg-${foreground}` : "",
            typeof background === "number" ? `ansi-bg-${background}` : "",
        ].filter(Boolean);
        const attributes = [
            classes.length ? `class="${classes.join(" ")}"` : "",
            typeof foreground === "string"
                ? `data-ansi-fg="${foreground}"`
                : "",
            typeof background === "string"
                ? `data-ansi-bg="${background}"`
                : "",
        ].filter(Boolean);
        output += attributes.length
            ? `<span ${attributes.join(" ")}>${escaped}</span>`
            : escaped;
    };
    const rgb = (values: string[]): string | undefined => {
        if (
            values.length !== 3 ||
            !values.every(
                (value) => /^\d+$/.test(value) && Number(value) <= 255,
            )
        )
            return undefined;
        return (
            "#" +
            values
                .map((value) => Number(value).toString(16).padStart(2, "0"))
                .join("")
        );
    };
    const indexed = (
        value: string | undefined,
    ): number | string | undefined => {
        if (value === undefined || !/^\d+$/.test(value) || Number(value) > 255)
            return undefined;
        const index = Number(value);
        if (index < 16) return index;
        if (index >= 232)
            return rgb(Array(3).fill(String(8 + (index - 232) * 10)));
        const offset = index - 16;
        const levels = [0, 95, 135, 175, 215, 255];
        return rgb(
            [
                levels[Math.floor(offset / 36)]!,
                levels[Math.floor(offset / 6) % 6]!,
                levels[offset % 6]!,
            ].map(String),
        );
    };
    const setColor = (code: number, value: number | string | undefined) => {
        if (value === undefined) return;
        if (code === 38) foreground = value;
        else if (code === 48) background = value;
    };
    let start = 0;
    for (let index = 0; index < input.length;) {
        if (input[index] !== "\x1b") {
            index++;
            continue;
        }
        emit(input.slice(start, index));
        const kind = input[++index];
        if (kind === "[") {
            const parameters = ++index;
            while (index < input.length && !/[@-~]/.test(input[index]!))
                index++;
            if (input[index] === "m") {
                const raw = input.slice(parameters, index);
                if (/^[\d;:]*$/.test(raw)) {
                    const codes = raw.split(";");
                    for (
                        let position = 0;
                        position < codes.length;
                        position++
                    ) {
                        const parameter = codes[position]!;
                        if (parameter.includes(":")) {
                            const parts = parameter.split(":");
                            const code = Number(parts[0]);
                            if (parts[1] === "5" && parts.length === 3)
                                setColor(code, indexed(parts[2]));
                            else if (parts[1] === "2") {
                                if (parts.length === 5)
                                    setColor(code, rgb(parts.slice(2)));
                                else if (
                                    parts.length === 6 &&
                                    (parts[2] === "" || parts[2] === "0")
                                )
                                    setColor(code, rgb(parts.slice(3)));
                            }
                            continue;
                        }
                        const code = Number(parameter || "0");
                        if (code === 0) {
                            foreground = background = undefined;
                            bold = false;
                        } else if (code === 1) bold = true;
                        else if (code === 22) bold = false;
                        else if (code === 39) foreground = undefined;
                        else if (code === 49) background = undefined;
                        else if (code >= 30 && code <= 37)
                            foreground = code - 30;
                        else if (code >= 90 && code <= 97)
                            foreground = code - 90 + 8;
                        else if (code >= 40 && code <= 47)
                            background = code - 40;
                        else if (code >= 100 && code <= 107)
                            background = code - 100 + 8;
                        // Consume color operands even when malformed; they are not SGR commands.
                        else if (code === 38 || code === 48 || code === 58) {
                            const mode = codes[++position];
                            if (mode === "5")
                                setColor(code, indexed(codes[++position]));
                            else if (mode === "2") {
                                setColor(
                                    code,
                                    rgb(
                                        codes.slice(position + 1, position + 4),
                                    ),
                                );
                                position += 3;
                            } else break;
                        }
                    }
                }
            }
            if (index < input.length) index++;
        } else if (kind === "]") {
            index++;
            while (
                index < input.length &&
                input[index] !== "\x07" &&
                !(input[index] === "\x1b" && input[index + 1] === "\\")
            )
                index++;
            if (input[index] === "\x07") index++;
            else if (index < input.length) index += 2;
        } else if (index < input.length) index++;
        start = index;
    }
    emit(input.slice(start));
    return output;
};

// Individual CSS property assignments retain the page's strict style-src policy.
export const applyAnsiColors = (root: HTMLElement): void => {
    for (const span of root.querySelectorAll<HTMLElement>(
        "[data-ansi-fg], [data-ansi-bg]",
    )) {
        const foreground = span.dataset.ansiFg;
        const background = span.dataset.ansiBg;
        if (foreground && /^#[0-9a-f]{6}$/.test(foreground))
            span.style.color = foreground;
        if (background && /^#[0-9a-f]{6}$/.test(background))
            span.style.backgroundColor = background;
    }
};

const colors = [
    "#000000",
    "#cd3131",
    "#0dbc79",
    "#e5e510",
    "#2472c8",
    "#bc3fbc",
    "#11a8cd",
    "#e5e5e5",
    "#666666",
    "#f14c4c",
    "#23d18b",
    "#f5f543",
    "#3b8eea",
    "#d670d6",
    "#29b8db",
    "#ffffff",
];
export const ansiStyles =
    ".ansi-bold{font-weight:bold}" +
    colors
        .map(
            (color, index) =>
                `.ansi-fg-${index}{color:${color}}.ansi-bg-${index}{background-color:${color}}`,
        )
        .join("");
