import { Editor } from '../../editor/Editor'
import { computeLayout, type Layout } from '../../editor/layout'
import { atom, computed } from '../../state/signals'
import type { Plan } from './plan'

/**
 * The real editor (camera, pan and zoom, tools, hit testing) with its layout replaced by the
 * detached-header plan (see plan.ts), set each frame something moves. Nothing in Editor changes:
 * this only replaces the `layout` it, the renderer and the tools read.
 */
export class SubagentEditor extends Editor {
	readonly plan = atom<Plan | null>('plan', null)
	/** every session laid out by the canvas's own rules, side by side (what the stock editor shows) */
	readonly naturalLayout = computed<Layout>('naturalLayout', () =>
		computeLayout(this.sessions.get(), this.items.get(), this.sessionOrder.get(), this.itemLimits.get()),
	)
	override readonly layout = computed<Layout>('layout', () => this.plan.get()?.layout ?? this.naturalLayout.get())
}
