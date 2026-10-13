/**
 * A tiny signals library in the spirit of @tldraw/state.
 *
 * - `atom` holds a value. Setting it bumps a global epoch.
 * - `computed` derives a value lazily and caches it until one of its parents changes.
 * - `react` runs a side effect whenever the signals it read last time change.
 *
 * Every signal records the epoch at which it last changed, so "did anything change since
 * I last looked?" is just an integer comparison. The render loop uses that to skip frames.
 */

interface Parent {
	lastChangedEpoch: number
	refresh(): void
}

interface Child {
	parents: Parent[]
	parentEpochs: number[]
}

let globalEpoch = 1
let capturing: Child | null = null
let transactionDepth = 0
let flushing = false
let needsFlush = false
const reactors = new Set<Reactor>()

export function getGlobalEpoch() {
	return globalEpoch
}

function capture(parent: Parent) {
	if (!capturing || capturing.parents.includes(parent)) return
	capturing.parents.push(parent)
	capturing.parentEpochs.push(parent.lastChangedEpoch)
}

function track<T>(child: Child, fn: () => T): T {
	const prev = capturing
	child.parents = []
	child.parentEpochs = []
	capturing = child
	try {
		return fn()
	} finally {
		capturing = prev
	}
}

function haveParentsChanged(child: Child) {
	for (let i = 0; i < child.parents.length; i++) {
		const p = child.parents[i]
		p.refresh()
		if (p.lastChangedEpoch !== child.parentEpochs[i]) return true
	}
	return false
}

export class Atom<T> implements Parent {
	lastChangedEpoch = globalEpoch

	constructor(
		readonly name: string,
		private value: T,
		private isEqual: (a: T, b: T) => boolean = Object.is,
	) {}

	refresh() {}

	get(): T {
		capture(this)
		return this.value
	}

	peek(): T {
		return this.value
	}

	set(value: T) {
		if (this.isEqual(this.value, value)) return
		this.value = value
		this.lastChangedEpoch = ++globalEpoch
		if (transactionDepth === 0) flushReactors()
	}

	update(fn: (value: T) => T) {
		this.set(fn(this.value))
	}
}

export class Computed<T> implements Parent, Child {
	parents: Parent[] = []
	parentEpochs: number[] = []
	lastChangedEpoch = -1
	private lastCheckedEpoch = -1
	private value: T | undefined
	private hasValue = false

	constructor(
		readonly name: string,
		private fn: (prev: T | undefined) => T,
		private isEqual: (a: T, b: T) => boolean = Object.is,
	) {}

	refresh() {
		if (this.lastCheckedEpoch === globalEpoch) return
		this.lastCheckedEpoch = globalEpoch
		if (this.hasValue && !haveParentsChanged(this)) return
		const next = track(this, () => this.fn(this.value))
		if (!this.hasValue || !this.isEqual(this.value as T, next)) {
			this.value = next
			this.hasValue = true
			this.lastChangedEpoch = globalEpoch
		}
	}

	get(): T {
		this.refresh()
		capture(this)
		return this.value as T
	}
}

class Reactor implements Child {
	parents: Parent[] = []
	parentEpochs: number[] = []
	constructor(private fn: () => void) {}
	run() {
		track(this, this.fn)
	}
	maybeRun() {
		if (haveParentsChanged(this)) this.run()
	}
}

function flushReactors() {
	if (flushing) {
		needsFlush = true
		return
	}
	flushing = true
	try {
		do {
			needsFlush = false
			for (const r of [...reactors]) if (reactors.has(r)) r.maybeRun()
		} while (needsFlush)
	} finally {
		flushing = false
	}
}

export function atom<T>(name: string, value: T, isEqual?: (a: T, b: T) => boolean) {
	return new Atom(name, value, isEqual)
}

export function computed<T>(name: string, fn: (prev: T | undefined) => T, isEqual?: (a: T, b: T) => boolean) {
	return new Computed(name, fn, isEqual)
}

/** Run `fn` now and again whenever anything it read changes. Returns a stop function. */
export function react(fn: () => void): () => void {
	const r = new Reactor(fn)
	r.run()
	reactors.add(r)
	return () => {
		reactors.delete(r)
	}
}

/** Batch several updates so reactors run once, after all of them. */
export function transact<T>(fn: () => T): T {
	transactionDepth++
	try {
		return fn()
	} finally {
		if (--transactionDepth === 0) flushReactors()
	}
}
