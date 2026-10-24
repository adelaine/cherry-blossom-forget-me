/** @jsxImportSource preact */
import { useLayoutEffect, useRef } from "preact/hooks";
import { ansiToHtml, applyAnsiColors } from "./ansi.ts";

export function AnsiLog({
    id,
    text,
    label,
}: {
    id: string;
    text: string;
    label: string;
}) {
    const element = useRef<HTMLPreElement>(null);
    const bottom =
        !element.current ||
        element.current.scrollTop + element.current.clientHeight >=
            element.current.scrollHeight - 24;
    useLayoutEffect(() => {
        if (!element.current) return;
        applyAnsiColors(element.current);
        if (bottom) element.current.scrollTop = element.current.scrollHeight;
    }, [text]);
    return (
        <pre
            ref={element}
            id={id}
            tabIndex={0}
            aria-label={label}
            dangerouslySetInnerHTML={{ __html: ansiToHtml(text) }}
        />
    );
}
