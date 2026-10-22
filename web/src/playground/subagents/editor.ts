import { Editor } from '../../editor/Editor'
import { computeLayout, type Layout } from '../../editor/layout'
import { layoutFamilies, type Family } from '../../editor/subagentLayout'
import { atom, computed } from '../../state/signals'

/**
 * The real editor (camera, pan and zoom, tools, hit testing), with its layout post-processed so
 * subagent frames sit in their parent's family to the right of it (see subagentLayout.ts). Nothing
 * in Editor changes: this only replaces the `layout` it, the renderer and the tools read.
 */
export class SubagentEditor extends Editor {
	readonly families = atom<{ list: Family[]; gutter: number }>('families', { list: [], gutter: 160 })
	/** every session laid out by the canvas's own rules, side by side (what the stock editor shows) */
	readonly naturalLayout = computed<Layout>('naturalLayout', () =>
		computeLayout(this.sessions.get(), this.items.get(), this.sessionOrder.get(), this.itemLimits.get()),
	)
	override readonly layout = computed<Layout>('layout', () => {
		const { list, gutter } = this.families.get()
		return layoutFamilies(this.naturalLayout.get(), list, { gutter })
	})
}
