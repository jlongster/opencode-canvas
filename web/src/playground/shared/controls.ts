import type { ParamDef, ParamValues } from './params'

/*
 * A small control set for the playground panels, after Radix (slider anatomy and keyboard model),
 * Leva and Tweakpane (scrubbable number fields, alt/shift modifiers) and Figma's properties panel
 * (label left, compact 28px rows). Everything is keyboard reachable with a visible focus ring.
 */

type RangeDef = Extract<ParamDef, { type: 'range' }>

let uid = 0
const nextId = (p: string) => `${p}-${++uid}`

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag)
	if (className) e.className = className
	e.append(...children)
	return e
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function decimals(step: number) {
	const s = String(step)
	return s.includes('.') ? s.split('.')[1].length : 0
}

function quantize(d: RangeDef, v: number, fine: boolean) {
	const step = fine ? d.step / 10 : d.step
	const q = Math.round((v - d.min) / step) * step + d.min
	return Number(clamp(q, d.min, d.max).toFixed(decimals(step)))
}

export function formatValue(d: RangeDef, v: number) {
	// One more decimal for values set finely (alt).
	const base = decimals(d.step)
	return v.toFixed(Number(v.toFixed(base)) === v ? base : base + 1)
}

/** Modifier multiplier: shift ×10, alt ×0.1 (as in Leva and Tweakpane). */
const mult = (e: { shiftKey: boolean; altKey: boolean }) => (e.shiftKey ? 10 : 1) * (e.altKey ? 0.1 : 1)

/**
 * A number field you scrub by dragging horizontally on it (shift ×10, alt ×0.1) and click to type
 * into; Enter commits, Escape reverts, arrows step.
 */
export function numberField(d: RangeDef, get: () => number, set: (v: number, fine: boolean) => void, labelledBy?: string) {
	const wrap = el('div', 'c-num')
	const input = el('input')
	input.inputMode = 'decimal'
	input.spellcheck = false
	input.autocomplete = 'off'
	if (labelledBy) input.setAttribute('aria-labelledby', labelledBy)
	wrap.append(input)
	if (d.unit) wrap.append(el('span', 'unit', d.unit))
	let editing = false
	const show = () => {
		if (!editing) input.value = formatValue(d, get())
	}
	const startEdit = () => {
		if (editing) return
		editing = true
		wrap.classList.add('editing')
		input.focus()
		input.select()
	}
	const endEdit = (commit: boolean) => {
		if (!editing) return
		editing = false
		wrap.classList.remove('editing')
		if (commit) {
			const v = parseFloat(input.value.replace(',', '.'))
			if (isFinite(v)) set(v, true)
		}
		show()
	}
	wrap.addEventListener('pointerdown', (e) => {
		if (editing || e.button !== 0) return
		e.preventDefault()
		wrap.setPointerCapture(e.pointerId)
		const startX = e.clientX
		let last = e.clientX
		let moved = false
		let raw = get()
		const perPx = (d.max - d.min) / 240
		const move = (m: PointerEvent) => {
			if (!moved && Math.abs(m.clientX - startX) < 3) return
			moved = true
			raw = clamp(raw + (m.clientX - last) * perPx * mult(m), d.min, d.max)
			last = m.clientX
			set(raw, m.altKey)
		}
		const up = () => {
			wrap.removeEventListener('pointermove', move)
			wrap.removeEventListener('pointerup', up)
			wrap.removeEventListener('pointercancel', up)
			if (!moved) startEdit()
		}
		wrap.addEventListener('pointermove', move)
		wrap.addEventListener('pointerup', up)
		wrap.addEventListener('pointercancel', up)
	})
	input.addEventListener('focus', startEdit)
	input.addEventListener('blur', () => endEdit(true))
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			endEdit(true)
			input.blur()
		} else if (e.key === 'Escape') {
			endEdit(false)
			input.blur()
		} else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault()
			set(get() + (e.key === 'ArrowUp' ? 1 : -1) * d.step * mult(e), e.altKey)
			input.value = formatValue(d, get())
		}
	})
	show()
	return { el: wrap, update: show }
}

/** Label, slider (track, range, thumb) and a scrubbable number field. Double-click resets. */
export function sliderRow(d: RangeDef, values: ParamValues, onChange: () => void) {
	const id = nextId('c')
	const row = el('div', 'c-row')
	const label = el('label', 'c-label', d.label)
	label.id = `${id}-label`
	const slider = el('div', 'c-slider')
	slider.tabIndex = 0
	slider.setAttribute('role', 'slider')
	slider.setAttribute('aria-labelledby', label.id)
	slider.setAttribute('aria-valuemin', String(d.min))
	slider.setAttribute('aria-valuemax', String(d.max))
	slider.dataset.key = d.key
	const track = el('div', 'c-track')
	const range = el('div', 'c-range')
	track.append(range)
	const tick = el('div', 'c-tick')
	const thumb = el('div', 'c-thumb')
	slider.append(track, tick, thumb)
	label.title = 'Double-click to reset'

	const get = () => values[d.key] as number
	const pct = (v: number) => (v - d.min) / (d.max - d.min)
	const place = (v: number) => `calc(6px + ${pct(v)} * (100% - 12px))`
	const set = (v: number, fine = false) => {
		const q = quantize(d, v, fine)
		if (q === get()) return
		values[d.key] = q
		render()
		onChange()
	}
	const num = numberField(d, get, set, label.id)
	const render = () => {
		const v = get()
		range.style.width = place(v)
		thumb.style.left = place(v)
		slider.setAttribute('aria-valuenow', String(v))
		slider.setAttribute('aria-valuetext', `${formatValue(d, v)}${d.unit ? ` ${d.unit}` : ''}`)
		num.update()
	}
	tick.style.left = place(d.value)
	const reset = () => set(d.value)
	label.addEventListener('dblclick', reset)
	slider.addEventListener('dblclick', reset)

	slider.addEventListener('pointerdown', (e) => {
		if (e.button !== 0) return
		e.preventDefault()
		slider.focus()
		slider.setPointerCapture(e.pointerId)
		slider.classList.add('active')
		const rect = slider.getBoundingClientRect()
		const usable = Math.max(1, rect.width - 12)
		const thumbX = rect.left + 6 + pct(get()) * usable
		// Grabbing the thumb keeps its value; clicking the track jumps there. After that the drag is
		// relative, so alt can slow it down (×0.1) without the value jumping.
		if (Math.abs(e.clientX - thumbX) > 8) set(d.min + clamp((e.clientX - rect.left - 6) / usable, 0, 1) * (d.max - d.min))
		let raw = get()
		let last = e.clientX
		const move = (m: PointerEvent) => {
			raw = clamp(raw + ((m.clientX - last) / usable) * (d.max - d.min) * (m.altKey ? 0.1 : 1), d.min, d.max)
			last = m.clientX
			set(raw, m.altKey)
		}
		const up = () => {
			slider.classList.remove('active')
			slider.removeEventListener('pointermove', move)
			slider.removeEventListener('pointerup', up)
			slider.removeEventListener('pointercancel', up)
		}
		slider.addEventListener('pointermove', move)
		slider.addEventListener('pointerup', up)
		slider.addEventListener('pointercancel', up)
	})
	slider.addEventListener('keydown', (e) => {
		const big = (d.max - d.min) / 10
		const k = e.key
		let v: number | null = null
		if (k === 'ArrowRight' || k === 'ArrowUp') v = get() + d.step * mult(e)
		else if (k === 'ArrowLeft' || k === 'ArrowDown') v = get() - d.step * mult(e)
		else if (k === 'PageUp') v = get() + big
		else if (k === 'PageDown') v = get() - big
		else if (k === 'Home') v = d.min
		else if (k === 'End') v = d.max
		if (v === null) return
		e.preventDefault()
		e.stopPropagation()
		set(v, e.altKey)
	})
	render()
	row.append(label, slider, num.el)
	return row
}

/** A segmented control (radiogroup) with one sliding indicator; arrow keys move the choice. */
export function segmented(options: string[], value: string, onChange: (v: string) => void, ariaLabel: string) {
	const seg = el('div', 'c-seg')
	seg.setAttribute('role', 'radiogroup')
	seg.setAttribute('aria-label', ariaLabel)
	const ind = el('span', 'c-seg-ind')
	ind.style.width = `calc((100% - 4px) / ${options.length})`
	seg.append(ind)
	const buttons = options.map((o) => {
		const b = el('button', '', o)
		b.type = 'button'
		b.setAttribute('role', 'radio')
		b.dataset.value = o
		b.addEventListener('click', () => choose(o, false))
		return b
	})
	seg.append(...buttons)
	let current = value
	const render = () => {
		const i = Math.max(0, options.indexOf(current))
		ind.style.transform = `translateX(calc(2px + ${i} * 100%))`
		buttons.forEach((b, j) => {
			b.setAttribute('aria-checked', String(j === i))
			b.tabIndex = j === i ? 0 : -1
		})
	}
	const choose = (o: string, focus: boolean) => {
		if (o !== current) {
			current = o
			render()
			onChange(o)
		}
		if (focus) buttons[options.indexOf(o)].focus()
	}
	seg.addEventListener('keydown', (e) => {
		const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
		if (!d) return
		e.preventDefault()
		e.stopPropagation()
		choose(options[(options.indexOf(current) + d + options.length) % options.length], true)
	})
	render()
	return seg
}

export function switchControl(checked: boolean, onChange: (v: boolean) => void, id?: string) {
	const b = el('button', 'c-switch')
	b.type = 'button'
	b.setAttribute('role', 'switch')
	if (id) b.id = id
	let on = checked
	const render = () => b.setAttribute('aria-checked', String(on))
	b.addEventListener('click', () => {
		on = !on
		render()
		onChange(on)
	})
	render()
	return b
}

export function switchRow(label: string, checked: boolean, onChange: (v: boolean) => void, key?: string) {
	const id = nextId('sw')
	const l = el('label', 'c-label', label)
	l.htmlFor = id
	const s = switchControl(checked, onChange, id)
	if (key) s.dataset.key = key
	const row = el('div', 'c-row c-row-2', l, s)
	return row
}

export function segmentedRow(label: string, options: string[], value: string, onChange: (v: string) => void) {
	return el('div', 'c-row c-row-2', el('span', 'c-label', label), segmented(options, value, onChange, label))
}

export function button(label: string, onClick: () => void, variant: '' | 'primary' | 'ghost' = '', small = false) {
	const b = el('button', `c-btn${variant ? ` ${variant}` : ''}${small ? ' small' : ''}`, label)
	b.type = 'button'
	b.addEventListener('click', onClick)
	return b
}

// ---------- colour swatch with a palette popover ----------

let openPop: { el: HTMLElement; close: () => void } | null = null

export function swatch(value: string, palette: string[], onChange: (v: string) => void, ariaLabel: string) {
	const b = el('button', 'c-swatch')
	b.type = 'button'
	b.setAttribute('aria-label', ariaLabel)
	b.setAttribute('aria-haspopup', 'dialog')
	let current = value
	const paint = () => b.style.setProperty('--c', current)
	paint()
	const pick = (c: string) => {
		current = c
		paint()
		onChange(c)
	}
	b.addEventListener('click', (e) => {
		e.stopPropagation()
		if (openPop) {
			const wasMine = openPop.el.dataset.owner === ariaLabel
			openPop.close()
			if (wasMine) return
		}
		const pop = el('div', 'c-pop')
		pop.setAttribute('role', 'dialog')
		pop.setAttribute('aria-label', ariaLabel)
		pop.dataset.owner = ariaLabel
		const chips = palette.map((c) => {
			const s = el('button', 'c-swatch')
			s.type = 'button'
			s.style.setProperty('--c', c)
			s.setAttribute('aria-label', c)
			s.setAttribute('aria-pressed', String(c.toLowerCase() === current.toLowerCase()))
			s.addEventListener('click', () => {
				pick(c)
				close()
				b.focus()
			})
			return s
		})
		const hex = el('input', 'c-hex')
		hex.value = current
		hex.setAttribute('aria-label', 'Hex colour')
		hex.spellcheck = false
		hex.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				const v = hex.value.trim()
				const m = /^#?([0-9a-f]{6})$/i.exec(v)
				if (m) pick(`#${m[1].toLowerCase()}`)
				close()
				b.focus()
			}
		})
		pop.append(...chips, hex)
		document.body.append(pop)
		const r = b.getBoundingClientRect()
		const w = pop.offsetWidth
		pop.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, r.right - w))}px`
		pop.style.top = `${Math.min(innerHeight - pop.offsetHeight - 8, r.bottom + 8)}px`
		const outside = (e: PointerEvent) => {
			if (!pop.contains(e.target as Node)) close()
		}
		const esc = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				close()
				b.focus()
			}
		}
		const close = () => {
			pop.remove()
			document.removeEventListener('pointerdown', outside, true)
			document.removeEventListener('keydown', esc, true)
			openPop = null
		}
		document.addEventListener('pointerdown', outside, true)
		document.addEventListener('keydown', esc, true)
		openPop = { el: pop, close }
		;(chips.find((c) => c.getAttribute('aria-pressed') === 'true') ?? chips[0]).focus()
	})
	return b
}

export function colorRow(label: string, value: string, palette: string[], onChange: (v: string) => void) {
	return el('div', 'c-row c-row-2', el('span', 'c-label', label), swatch(value, palette, onChange, label))
}

// ---------- listbox ----------

export interface ListItem {
	id: string
	name: string
	key: string
	title?: string
}

/** A listbox where selection follows focus (arrow keys, Home/End). */
export function listbox(items: ListItem[], selected: string, onSelect: (id: string) => void, ariaLabel: string) {
	const list = el('div', 'c-list')
	list.setAttribute('role', 'listbox')
	list.setAttribute('aria-label', ariaLabel)
	const options = items.map((it) => {
		const o = el('button', 'c-option', el('span', 'key', it.key), el('span', 'name', it.name))
		o.type = 'button'
		o.setAttribute('role', 'option')
		o.dataset.id = it.id
		if (it.title) o.title = it.title
		o.addEventListener('click', () => choose(it.id, false))
		return o
	})
	list.append(...options)
	let current = selected
	const render = () =>
		options.forEach((o) => {
			const on = o.dataset.id === current
			o.setAttribute('aria-selected', String(on))
			o.tabIndex = on ? 0 : -1
		})
	const choose = (id: string, focus: boolean) => {
		if (id !== current) {
			current = id
			render()
			onSelect(id)
		}
		if (focus) options.find((o) => o.dataset.id === id)?.focus()
	}
	list.addEventListener('keydown', (e) => {
		const i = items.findIndex((it) => it.id === current)
		let j = -1
		if (e.key === 'ArrowDown') j = (i + 1) % items.length
		else if (e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length
		else if (e.key === 'Home') j = 0
		else if (e.key === 'End') j = items.length - 1
		if (j < 0) return
		e.preventDefault()
		e.stopPropagation()
		choose(items[j].id, true)
	})
	render()
	return { el: list, select: (id: string) => choose(id, false) }
}

/** The right control for a param. */
export function paramControl(d: ParamDef, values: ParamValues, onChange: () => void, palette: string[] = []): HTMLElement {
	if (d.type === 'range') return sliderRow(d, values, onChange)
	if (d.type === 'toggle')
		return switchRow(
			d.label,
			!!values[d.key],
			(v) => {
				values[d.key] = v
				onChange()
			},
			d.key,
		)
	if (d.type === 'color')
		return colorRow(d.label, values[d.key] as string, palette, (v) => {
			values[d.key] = v
			onChange()
		})
	return segmentedRow(d.label, d.options, values[d.key] as string, (v) => {
		values[d.key] = v
		onChange()
	})
}
