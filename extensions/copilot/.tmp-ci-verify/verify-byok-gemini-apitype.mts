/**
 * Manual, temporary verification for BYOK Custom Endpoint `apiType: 'gemini'`
 * (issue microsoft/vscode#329632). Not part of the permanent test suite: it calls
 * the live Gemini API, which the project's own vitest suite deliberately avoids.
 *
 * Imports the real resolveGeminiBaseUrl from customEndpointProvider.ts rather than
 * reimplementing it, so a pass here is evidence about the actual implementation.
 *
 * Run from extensions/copilot:
 *   npx tsx .tmp-ci-verify/verify-byok-gemini-apitype.mts <model>
 */
import { GoogleGenAI, Type } from '@google/genai';
import { resolveGeminiBaseUrl } from '../src/extension/byok/vscode-node/customEndpointProvider.js';

const MODEL = process.argv[2] ?? 'gemini-3.5-flash';
const HOST = 'https://generativelanguage.googleapis.com';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
	console.error('GEMINI_API_KEY is not set.');
	process.exit(1);
}

console.log(`model: ${MODEL}\n`);

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${detail}`);
	if (!ok) {
		failures++;
	}
}

function makeClient(userSuppliedUrl: string): GoogleGenAI {
	const { baseUrl, apiVersion } = resolveGeminiBaseUrl(userSuppliedUrl);
	console.log(`  using: baseUrl=${baseUrl} apiVersion=${apiVersion ?? '(sdk default)'}`);
	return new GoogleGenAI({
		apiKey,
		...(baseUrl ? { httpOptions: { baseUrl, apiVersion } } : {})
	});
}

console.log('[offline] resolveGeminiBaseUrl over every documented URL shape');
const cases: Array<[string, string, string | undefined]> = [
	[HOST, HOST, undefined],
	[`${HOST}/`, HOST, undefined],
	[`${HOST}/v1beta`, HOST, 'v1beta'],
	[`${HOST}/v1`, HOST, 'v1'],
	[`${HOST}/v1beta/models/${MODEL}:generateContent`, HOST, 'v1beta'],
	[`${HOST}/v1/models/${MODEL}:streamGenerateContent?alt=sse`, HOST, 'v1'],
	['https://gateway.example.com/acct/gw/google-ai-studio', 'https://gateway.example.com/acct/gw/google-ai-studio', undefined],
];
for (const [input, expectedBase, expectedVersion] of cases) {
	const got = resolveGeminiBaseUrl(input);
	const ok = got.baseUrl === expectedBase && got.apiVersion === expectedVersion;
	check(input, ok, `${got.baseUrl} / ${got.apiVersion}`);
}

console.log(`\n[network 1/3] basic round trip, baseUrl recovered from a full :generateContent URL`);
try {
	const client = makeClient(`${HOST}/v1beta/models/${MODEL}:generateContent`);
	const res = await client.models.generateContent({
		model: MODEL,
		contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }],
	});
	const text = res.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('').trim();
	check('response text', !!text, JSON.stringify(text));
} catch (err) {
	check('response text', false, err instanceof Error ? err.message : String(err));
}

console.log(`\n[network 2/3] streaming, apiVersion extracted from the URL`);
try {
	const client = makeClient(`${HOST}/v1beta`);
	const stream = await client.models.generateContentStream({
		model: MODEL,
		contents: [{ role: 'user', parts: [{ text: 'Count from 1 to 5, one number per line.' }] }],
	});
	let chunks = 0;
	let streamed = '';
	for await (const chunk of stream) {
		chunks++;
		streamed += chunk.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
	}
	check('multiple chunks', chunks > 1, `${chunks} chunks`);
	check('content received', streamed.includes('5'), JSON.stringify(streamed.slice(0, 60)));
} catch (err) {
	check('streaming', false, err instanceof Error ? err.message : String(err));
}

console.log(`\n[network 3/3] tool calling`);
try {
	const client = makeClient(HOST);
	const res = await client.models.generateContent({
		model: MODEL,
		contents: [{ role: 'user', parts: [{ text: 'What is the weather in Seoul? Use the tool.' }] }],
		config: {
			tools: [{
				functionDeclarations: [{
					name: 'get_weather',
					description: 'Get the current weather for a city',
					parameters: {
						type: Type.OBJECT,
						properties: { city: { type: Type.STRING, description: 'City name' } },
						required: ['city'],
					},
				}],
			}],
		},
	});
	const call = res.candidates?.[0]?.content?.parts?.find(p => p.functionCall)?.functionCall;
	check('tool call emitted', call?.name === 'get_weather', `${call?.name} ${JSON.stringify(call?.args)}`);
} catch (err) {
	check('tool call emitted', false, err instanceof Error ? err.message : String(err));
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
