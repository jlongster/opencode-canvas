import { listUrl } from '../sync/client'

export function NotFound({ message, hint }: { message: string; hint?: string }) {
	return (
		<div className="not-found">
			<h2>{message}</h2>
			{hint && <p>{hint}</p>}
			<a href={listUrl()}>All canvases</a>
		</div>
	)
}
