import { reactive, shallowRef, watch } from 'vue'
import { buildTransaction, deduplicate, generateManifest, getHash, manageUpload } from '@/functions/Transactions'
import { notify } from '@/store/NotificationStore'
import { TagField, TagSchema } from '@/components/atomic/InputGrid.vue'
import { readFile, FileWithPath } from '@/functions/File'
import { ArweaveProvider } from '@/providers/Arweave'
import type { CreateTransactionInterface } from 'arweave/web'


const formDefault = () => ({
	target: '',
	quantity: '',
	data: '' as string | ArDataItemParams[],
	tags: [] as { name: string, value: string }[],
	txFee: undefined as string | undefined,
	txSize: '0' as string | undefined,
	processedData: '' as string | CreateTransactionInterface['data'] | undefined,
})
export const formWallet = shallowRef<Wallet | undefined>()
export const form = reactive(formDefault())
export function reset () { Object.assign(form, formDefault()) }


// todo transaction sent notification delayed

watch(() => [form.data, formWallet.value?.key], async () => {
	form.processedData = undefined
	form.txSize = undefined
	form.txFee = undefined
	form.processedData = await getProcessedData(formWallet.value)
	form.txSize = (await getSize()).toString()
}, { deep: true })



export function addTag (name = '', value = '') { form.tags.push({ name, value }) }

export async function addFiles (files?: FileWithPath[]) {
	if (!files || !files.length) { form.data = ''; setBaseTags(form.tags, {}); return }
	form.data = await Promise.all(files?.map(async file => {
		const data = file instanceof File ? await readFile(file) : file
		const tags = [] as Tag[]
		setBaseTags(tags, {
			'Content-Type': file.type,
			'File-Hash': await getHash({ data })
		})
		return { data, tags, path: file.normalizedPath }
	}))
	if (files.length > 1) {
		setBaseTags(form.tags, {
			'Bundle-Format': 'binary',
			'Bundle-Version': '2.0.0',
		})
	} else {
		setBaseTags(form.tags, {
			'Content-Type': files[0].type,
			'File-Hash': await getHash(form.data[0])
		})
	}
}

function setBaseTags (tags: Tag[], set: { [key: string]: string }) {
	const baseTags: { [key: string]: string } = {
		'Content-Type': '',
		'File-Hash': '',
		'Bundle-Format': '',
		'Bundle-Version': '',
		...set
	}
	for (const name in baseTags) { setTag(tags, name, baseTags[name]) }
}

function setTag (tags: Tag[], name: string, value?: string) {
	let currentTag = tags.find(tag => tag.name === name)
	if (value) {
		if (!currentTag) {
			currentTag = { name, value: '' }
			tags.push(currentTag)
		}
		currentTag.value = value
	} else {
		const index = tags.indexOf(currentTag!)
		if (index !== -1) { tags.splice(index, 1) }
	}
}

export async function submit (wallet: Wallet) {
	try {
		if (!form.txFee) { return notify.error('Transaction fee not set') }
		if (form.data && !form.processedData) { return notify.error('Data not ready') } // todo make sure it matches current form data
		const tx = await buildTransaction({
			target: form.target,
			ar: form.quantity,
			arReward: form.txFee,
			tags: form.tags,
			data: form.processedData,
		})
		await wallet.signTransaction(tx)
		manageUpload(tx)
		reset()
	} catch (e: any) {
		console.error(e)
		notify.error(e)
	}
}

async function getProcessedData (wallet?: Wallet): Promise<ArTxParams['data']> {
	if (typeof form.data === 'string') { return form.data }
	if (form.data.length > 1) {
		if (!wallet) { throw 'multiple files unsupported for current account' }
		if (wallet instanceof ArweaveProvider) {
			const dataItems = await Promise.all(form.data.map(item => wallet.createDataItem(item)))
			const trustedAddresses = wallet.key ? [wallet.key] : []
			const deduplicated = await deduplicate(dataItems, trustedAddresses)
			console.log(deduplicated)
			// form.data.forEach((item, i) => deduplicated[i] ? item.deduplicate = deduplicated[i] : delete item.deduplicate)
			const deduplicatedDataItems = dataItems.map((item, i) => deduplicated[i] || item)
			const paths = form.data.map(item => item.path || '')
			console.log(paths)
			const manifest = generateManifest(paths, deduplicatedDataItems, paths[0])
			console.log(manifest.data)
			const manifestDataItem = await wallet.createDataItem({ ...manifest })
			console.log([...dataItems, manifestDataItem])
			return (await wallet.createBundle([...dataItems.filter(item => typeof item !== 'string'), manifestDataItem])).getRaw()
		}
		else { throw 'multiple files unsupported for ' + wallet.metadata.name }
	}
	return form.data[0].data
}

async function getSize (): Promise<number> {
	if (typeof form.data === 'string') { return form.data.length }
	// const randomProvider = wallet || await getRandomArweaveProvider()
	// const processed = await getProcessedData(randomProvider)
	const processed = form.processedData
	if (processed == undefined) { throw 'Error' }
	if (typeof processed === 'string') { return form.data.length }
	return ArrayBuffer.isView(processed) ? processed?.byteLength : new Uint8Array(processed).byteLength
}