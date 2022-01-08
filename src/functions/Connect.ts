import Arweave from 'arweave'
import { state, states, connectorChannels, filterChannels, initConnectorChannel, hasStorageAccess, awaitStorageAccess } from '@/functions/Channels'
import JsonRpc from '@/functions/JsonRpc'
import { watch, watchEffect, computed, reactive, ref, Ref } from 'vue'
import { getWalletById } from '@/functions/Wallets'
import { awaitEffect } from '@/functions/AsyncData'

let windowRef: Window
const { origin, session } = state
const sharedState: Ref<ConnectorState | null> = ref(null)
export const connectors = computed(() => {
	const allConnectors = Object.entries(connectorChannels.states)
		.filter(([key, val]) => key !== (origin! + session) && val.walletId !== false)
		.map(([key, val]) => val)
	if (sharedState.value && sharedState.value?.walletId !== false) { allConnectors.push(sharedState.value) }
	return allConnectors.sort((a, b) => a.timestamp! - b.timestamp!)
})



if (window.opener) {
	localStorage.setItem('global', '1')
	state.type = 'popup'
	windowRef = window.opener
	initConnector()
} else if (window.parent && window.parent !== window) {
	state.type = 'iframe'
	windowRef = window.parent
	initConnector()
} else {
	localStorage.setItem('global', '1')
	state.type = 'client'
	// if sharedState.link was active for a connection and iframe is unloaded, disconnect
	// only show connections when popup or iframe is active
}

export { state }



async function initConnector () {
	await awaitStorageAccess()
	const { state: connectorState, deleteChannel } = initConnectorChannel()
	sharedState.value = connectorState
	const connect = () => {
		// todo reject transactions that are designated to current address
		if (!connectorState.walletId) { return }
		const wallet = getWalletById(connectorState.walletId)
		if (!wallet) { return }
		postMessage({ method: 'connect', params: wallet.key })
	}
	const disconnect = () => { deleteChannel(); postMessage({ method: 'disconnect' }) }
	watch(() => connectorState.walletId, (id) => id === false ? disconnect() : connect())
	watchEffect(() => {
		const linkedState = Object.entries(filterChannels({ origin, session, type: state.type === 'popup' ? 'iframe' : 'popup' }))[0]?.[1]
		if (linkedState) { connectorState.link = true }
		const disconnectCondition = () => !linkedState && state.type === 'iframe' && connectorState.link && (connectorState.walletId == null || connectorState.walletId === false)
		if (disconnectCondition()) { setTimeout(() => disconnectCondition() && disconnect(), 500) }
	})
	const jsonRpc = new JsonRpc(postMessage, connectorState)
	window.addEventListener('message', (e) => {
		if (e.source !== windowRef || e.origin !== origin) { return }
		console.info(`${location.hostname}:${state.type}:`, e.data)
		jsonRpc.pushMessage(e.data)
	})
	if (state.type === 'iframe') { window.addEventListener('beforeunload', () => disconnect()) }
	postMessage({ method: 'ready' })
}



function postMessage (message: any) {
	if (!origin) { return }
	windowRef.postMessage({ ...message, jsonrpc: '2.0' }, origin)
}

export function navigateBack () {
	if (!window.opener) { return }
	try {
		window.open('', 'parent')
		window.opener.focus()
	} catch (e) { console.log(e) }
}

export function navigateBackAvailable (origin: string, session: string) {
	return window.opener && state.origin === origin && state.session === session
}
