// Keep this function self-contained: its compiled source also runs in the browser.
export function ansiToHtml(input: string): string {
    let foreground: number | undefined;
    let background: number | undefined;
    let bold = false;
    let output = "";
    const emit = (text: string) => {
        const escaped = text.replace(/[&<>"']/g, character => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        })[character]!);
        if (!escaped) return;
        const classes = [bold ? "ansi-bold" : "", foreground === undefined ? "" : `ansi-fg-${foreground}`, background === undefined ? "" : `ansi-bg-${background}`].filter(Boolean);
        output += classes.length ? `<span class="${classes.join(" ")}">${escaped}</span>` : escaped;
    };
    let start = 0;
    for (let index = 0; index < input.length;) {
        if (input[index] !== "\x1b") { index++; continue; }
        emit(input.slice(start, index));
        const kind = input[++index];
        if (kind === "[") {
            const parameters = ++index;
            while (index < input.length && !/[@-~]/.test(input[index]!)) index++;
            if (input[index] === "m") {
                const raw = input.slice(parameters, index);
                if (/^[\d;]*$/.test(raw)) {
                    const codes = raw.split(";").map(value => Number(value || "0"));
                    for (let position = 0; position < codes.length; position++) {
                        const code = codes[position]!;
                        if (code === 0) { foreground = background = undefined; bold = false; }
                        else if (code === 1) bold = true;
                        else if (code === 22) bold = false;
                        else if (code === 39) foreground = undefined;
                        else if (code === 49) background = undefined;
                        else if (code >= 30 && code <= 37) foreground = code - 30;
                        else if (code >= 90 && code <= 97) foreground = code - 90 + 8;
                        else if (code >= 40 && code <= 47) background = code - 40;
                        else if (code >= 100 && code <= 107) background = code - 100 + 8;
                        // Ignore extended colors together with their operands.
                        else if (code === 38 || code === 48 || code === 58) {
                            const mode = codes[++position];
                            if (mode === 5) position++;
                            else if (mode === 2) position += 3;
                            else break;
                        }
                    }
                }
            }
            if (index < input.length) index++;
        } else if (kind === "]") {
            index++;
            while (index < input.length && input[index] !== "\x07" && !(input[index] === "\x1b" && input[index + 1] === "\\")) index++;
            if (input[index] === "\x07") index++;
            else if (index < input.length) index += 2;
        } else if (index < input.length) index++;
        start = index;
    }
    emit(input.slice(start));
    return output;
}

const colors = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
export const ansiStyles = ".ansi-bold{font-weight:bold}" + colors.map((color, index) => `.ansi-fg-${index}{color:${color}}.ansi-bg-${index}{background-color:${color}}`).join("");
