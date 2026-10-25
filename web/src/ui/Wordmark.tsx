/** The mark: a frame inside a frame, the inner one a 50% dither (see .rm-mark). */
export function Wordmark({ size = 26 }: { size?: number }) {
	return <span className="rm-mark" style={{ width: size, height: size }} aria-hidden="true" />
}
