/* Copyright (c) 2026, Oracle and/or its affiliates. */
/** @jsxImportSource preact */

export type IconName =
	"building-2" | "package" | "rocket" | "wrench" | "circle-help";

/** Render a decorative icon beside a visible navigation or heading label. */
export function Icon({ name }: { name: IconName }) {
	return (
		<span
			class="panel-icon"
			style={{ maskImage: `url("/images/${name}.svg")` }}
			aria-hidden="true"
		/>
	);
}
