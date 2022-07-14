import { getCurrentScope, onScopeDispose, reactive, watch, ref, effectScope } from 'vue'
import type { EffectScope, Ref, WatchStopHandle } from 'vue'
import { useDataWrapper } from '@/functions/AsyncData'

type PrefixTable = {
	'instanceState:': InstanceState
	'sharedState:': SharedState
	'connectionSettings:': ConnectionSettings
	wallets: WalletDataInterface[]
	currency: { rate?: string, currency: string, provider: string, timestamp?: number }
	gateway: string
	bundler: string
	scannerCamera: string
	pwdTest: EncryptedContent | null
	pwdTestLock: number
	events: { [key: string]: any }
}



function ChannelRef <T extends keyof PrefixTable> (prefix: T, instanceName = '', init?: PrefixTable[T], writeInit?: boolean) {
	let stopWrite: WatchStopHandle
	let state = ref(init) as Ref<PrefixTable[T]> // todo can be undefined if no init
	let stateChannel = prefix + instanceName
	
	const writeState = () => {
		if (state.value === undefined) {
			localStorage.removeItem(stateChannel)
			return update()
		}
		const stateString = JSON.stringify(state.value)
		if (stateString === localStorage.getItem(stateChannel)) { return }
		localStorage.setItem(stateChannel, stateString)
	}
	const startWrite = () => stopWrite = watch(state, writeState, { deep: true })
	const update = (val?: string | null) => {
		if (stopWrite) { stopWrite() }
		if (val == undefined || val === 'undefined') {
			if (init === undefined) { startWrite(); return }
			val = JSON.stringify(init)
		}
		state.value = JSON.parse(val)
		startWrite()
	}
	const storageListener = (e: StorageEvent) => {
		if (e.key !== stateChannel || e.newValue === e.oldValue || !e.newValue) { return }
		update(e.newValue)
	}
	const stop = () => {
		window.removeEventListener('storage', storageListener)
		if (stopWrite) { stopWrite() }
	}
	const deleteChannel = () => {
		stop()
		localStorage.removeItem(stateChannel)
	}
	
	window.addEventListener('storage', storageListener)
	if (writeInit && !localStorage.getItem(stateChannel)) {
		if (typeof state.value === 'object' && Object.keys(state).length) { writeState() }
		else if (state.value !== undefined) { writeState() }
	}
	update(localStorage.getItem(stateChannel))
	if (getCurrentScope()) { onScopeDispose(() => stop()) }
	
	return { state, stop, deleteChannel }
}



const step = ref(0)
const channelInstances = {} as { [key: string]: { channel: ReturnType<typeof ChannelRef>, subscribers: number, scope: EffectScope } }

export function useChannel <T extends keyof PrefixTable> (prefix: T, instanceName = '', init?: PrefixTable[T], writeInit?: boolean) {
	const key = prefix + instanceName
	
	if (!channelInstances[key]) {
		const scope = effectScope(true)
		const channel = scope.run(() => ChannelRef(prefix, instanceName, init, writeInit))!
		channelInstances[key] = { channel, subscribers: 0, scope }
		step.value++
	}
	channelInstances[key].subscribers++
	
	const stop = () => {
		channelInstances[key].subscribers--
		if (channelInstances[key].subscribers > 0) { return }
		channelInstances[key].scope.stop()
		delete channelInstances[key]
		step.value++
	}
	const deleteChannel = () => {
		channelInstances[key]?.channel?.deleteChannel()
	}
	if (getCurrentScope()) { onScopeDispose(stop) }
	return { state: channelInstances[key].channel.state, stop, deleteChannel } as ReturnType<typeof ChannelRef<T>>
}



export function useLock (channel: Ref<number | undefined>) {
	let timer: any
	const isUsed = () => new Promise<boolean>(async res => {
		let hasChanged = false
		const stop = watch(channel, () => { hasChanged = true; res(true) })
		await new Promise(res => setTimeout(res, 1000))
		if (!hasChanged) { channel.value = 0; setTimeout(() => res(false)) }
		stop()
	})
	const lock = async () => {
		if (timer || channel.value && await isUsed()) { throw 'Feature already in use' }
		channel.value = 1
		timer = setInterval(() => channel.value!++, 1000)
	}
	const unlock = () => {
		clearInterval(timer)
		channel.value = 0
		timer = undefined
	}
	return { lock, unlock }
}



const hash = new URLSearchParams(window.location.hash.slice(1))
const origin = hash.get('origin') || undefined
const session = hash.get('session') || undefined
const appInfo = { name: hash.get('name') || undefined, logo: hash.get('logo') || undefined }
const instance = origin + Math.random().toString().slice(2)
const { state, deleteChannel } = useChannel('instanceState:', instance, { origin, session }, true)
const { states } = getChannels('instanceState:')
const connectorChannels = getChannels('sharedState:')
export { state, states, connectorChannels, appInfo }



function getChannels <T extends 'instanceState:' | 'sharedState:'> (prefix: T) {
	const channels: { [key: string]: ReturnType<typeof ChannelRef<T>> | undefined } = {}
	const states: { [key: string]: PrefixTable[T] } = reactive({})
	const getInstanceNames = () => Object.keys(localStorage)
		.filter(key => key.slice(0, prefix.length) === prefix)
		.map(key => key.slice(prefix.length))
	const instantiate = async (name: string) => {
		channels[name] = undefined
		if (prefix === 'instanceState:' && !(await heartbeat(name))) { close(name); return null }
		if (!Object.keys(channels).includes(name)) { return null }
		channels[name] = useChannel(prefix, name)
		states[name] = channels[name]!.state as any
	}
	const close = (name: string) => {
		channels[name]?.stop()
		delete channels[name]
		delete states[name]
	}
	const storageListener = () => {
		const runningChannels = Object.keys(channels)
		const storageChannels = getInstanceNames()
		for (const channel of [...runningChannels, ...storageChannels]) {
			if (runningChannels.includes(channel) && storageChannels.includes(channel)) { continue }
			else if (storageChannels.includes(channel) && channel !== instance) { instantiate(channel) }
			else if (runningChannels.includes(channel)) { close(channel) }
		}
	}
	const closeChannels = () => {
		window.removeEventListener('storage', storageListener)
		for (const channel in channels) { close(channel) }
	}
	watch(step, () => setTimeout(storageListener))
	window.addEventListener('storage', storageListener)
	storageListener()
	return { states, closeChannels }
}



async function heartbeat (instanceName: string, timeout?: number) {
	if (instanceName === instance) { return true }
	const fullKey = 'heartbeat:' + instanceName + instance
	const promise = new Promise(resolve => {
		const heartbeatListener = async (e: StorageEvent) => {
			if (e.key === fullKey && e.newValue) { heartbeatReturn(true) }
		}
		const heartbeatReturn = (result: boolean) => {
			if (result) { clearTimeout(cleanupTimeout) }
			setTimeout(() => localStorage.removeItem(fullKey), 1000)
			if (!result) { localStorage.removeItem('instanceState:' + instanceName) }
			window.removeEventListener('storage', heartbeatListener)
			resolve(result)
		}
		window.addEventListener('storage', heartbeatListener)
		const cleanupTimeout = setTimeout(() => heartbeatReturn(false), Math.max(5000, timeout || 0))
		if (timeout) { setTimeout(() => resolve(false), timeout) }
	})
	localStorage.setItem(fullKey, '')
	return promise
}

function cleanHeartbeats () {
	for (const key in localStorage) {
		if (key.slice(0, 'heartbeat:'.length) !== 'heartbeat:') { continue }
		const relatedChannel = 'instanceState:' + key.slice('heartbeat:'.length)
		if (localStorage.getItem(relatedChannel)) { continue }
		localStorage.removeItem(key)
	}
}

export function filterChannels (filter: object, object = states) {
	const filterFunction = ([key, state]: [string, any]) => typeof filter === 'function' ? filter(state)
		: !Object.entries(filter || {}).find(([key, value]) => state[key] !== value)
	return Object.fromEntries(Object.entries(object).filter(filterFunction))
}

function globalStorageListener (e: StorageEvent) {
	const partialKey = 'heartbeat:' + instance
	if (e.key?.slice(0, partialKey.length) === partialKey && e.newValue === '') {
		localStorage.setItem(e.key, 'ok')
	}
}

export async function hasStorageAccess () {
	if (document.hasStorageAccess && !await document.hasStorageAccess()) { return false }
	if (localStorage.getItem('global')) { return true }
}

export async function awaitStorageAccess () {
	while (!await hasStorageAccess()) { await new Promise(resolve => setTimeout(resolve, 1000)) }
}



cleanHeartbeats()
window.addEventListener('storage', globalStorageListener)
window.addEventListener('beforeunload', () => deleteChannel())