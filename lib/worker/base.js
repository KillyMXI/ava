import {createRequire} from 'module';
import {pathToFileURL} from 'url';
import {workerData} from 'worker_threads';

import setUpCurrentlyUnhandled from 'currently-unhandled';
import sourceMapSupport from 'source-map-support';

import {set as setChalk} from '../chalk.js';
import nowAndTimers from '../now-and-timers.cjs';
import providerManager from '../provider-manager.js';
import Runner from '../runner.js';
import serializeError from '../serialize-error.js';

import channel from './channel.cjs';
import dependencyTracking from './dependency-tracker.js';
import lineNumberSelection from './line-numbers.cjs';
import {set as setOptions} from './options.cjs';
import {flags, refs, sharedWorkerTeardowns} from './state.cjs';
import {isRunningInThread, isRunningInChildProcess} from './utils.cjs';

const currentlyUnhandled = setUpCurrentlyUnhandled();

const run = async options => {
	setOptions(options);
	setChalk(options.chalkOptions);

	if (options.chalkOptions.level > 0) {
		const {stdout, stderr} = process;
		global.console = Object.assign(global.console, new console.Console({stdout, stderr, colorMode: true}));
	}

	async function exit(code) {
		if (!process.exitCode) {
			process.exitCode = code;
		}

		dependencyTracking.flush();
		await channel.flush();
		process.exit();
	}

	// TODO: Initialize providers here, then pass to lineNumberSelection() so they
	// can be used to parse the test file.
	let checkSelectedByLineNumbers;
	try {
		checkSelectedByLineNumbers = lineNumberSelection({
			file: options.file,
			lineNumbers: options.lineNumbers
		});
	} catch (error) {
		channel.send({type: 'line-number-selection-error', err: serializeError('Line number selection error', false, error, options.file)});
		checkSelectedByLineNumbers = () => false;
	}

	const runner = new Runner({
		checkSelectedByLineNumbers,
		experiments: options.experiments,
		failFast: options.failFast,
		failWithoutAssertions: options.failWithoutAssertions,
		file: options.file,
		match: options.match,
		projectDir: options.projectDir,
		recordNewSnapshots: options.recordNewSnapshots,
		runOnlyExclusive: options.runOnlyExclusive,
		serial: options.serial,
		snapshotDir: options.snapshotDir,
		updateSnapshots: options.updateSnapshots
	});

	refs.runnerChain = runner.chain;

	channel.peerFailed.then(() => { // eslint-disable-line promise/prefer-await-to-then
		runner.interrupt();
	});

	const attributedRejections = new Set();
	process.on('unhandledRejection', (reason, promise) => {
		if (runner.attributeLeakedError(reason)) {
			attributedRejections.add(promise);
		}
	});

	runner.on('dependency', dependencyTracking.track);
	runner.on('stateChange', state => channel.send(state));

	runner.on('error', error => {
		channel.send({type: 'internal-error', err: serializeError('Internal runner error', false, error, runner.file)});
		exit(1);
	});

	runner.on('finish', async () => {
		try {
			const {touchedFiles} = runner.saveSnapshotState();
			if (touchedFiles) {
				channel.send({type: 'touched-files', files: touchedFiles});
			}
		} catch (error) {
			channel.send({type: 'internal-error', err: serializeError('Internal runner error', false, error, runner.file)});
			exit(1);
			return;
		}

		try {
			await Promise.all(sharedWorkerTeardowns.map(fn => fn()));
		} catch (error) {
			channel.send({type: 'uncaught-exception', err: serializeError('Shared worker teardown error', false, error, runner.file)});
			exit(1);
			return;
		}

		nowAndTimers.setImmediate(() => {
			for (const rejection of currentlyUnhandled().filter(rejection => !attributedRejections.has(rejection.promise))) {
				channel.send({type: 'unhandled-rejection', err: serializeError('Unhandled rejection', true, rejection.reason, runner.file)});
			}

			exit(0);
		});
	});

	process.on('uncaughtException', error => {
		if (runner.attributeLeakedError(error)) {
			return;
		}

		channel.send({type: 'uncaught-exception', err: serializeError('Uncaught exception', true, error, runner.file)});
		exit(1);
	});

	// Store value to prevent required modules from modifying it.
	const testPath = options.file;

	// Install basic source map support.
	sourceMapSupport.install({
		environment: 'node',
		handleUncaughtExceptions: false
	});

	const extensionsToLoadAsModules = Object.entries(options.moduleTypes)
		.filter(([, type]) => type === 'module')
		.map(([extension]) => extension);

	// Install before processing options.require, so if helpers are added to the
	// require configuration the *compiled* helper will be loaded.
	const {projectDir, providerStates = []} = options;
	const providers = (await Promise.all(providerStates.map(async ({type, state}) => {
		if (type === 'babel') {
			const provider = (await providerManager.babel(projectDir)).worker({extensionsToLoadAsModules, state});
			runner.powerAssert = provider.powerAssert;
			return provider;
		}

		if (type === 'typescript') {
			return (await providerManager.typescript(projectDir)).worker({extensionsToLoadAsModules, state});
		}

		return null;
	}))).filter(provider => provider !== null);

	const require = createRequire(import.meta.url);
	const load = async ref => {
		for (const extension of extensionsToLoadAsModules) {
			if (ref.endsWith(`.${extension}`)) {
				return import(pathToFileURL(ref));
			}
		}

		for (const provider of providers) {
			if (provider.canLoad(ref)) {
				return provider.load(ref, {requireFn: require});
			}
		}

		return require(ref);
	};

	try {
		for await (const ref of (options.require || [])) {
			await load(ref);
		}

		// Install dependency tracker after the require configuration has been evaluated
		// to make sure we also track dependencies with custom require hooks
		dependencyTracking.install(require.extensions, testPath);

		if (options.debug && options.debug.port !== undefined && options.debug.host !== undefined) {
			// If an inspector was active when the main process started, and is
			// already active for the worker process, do not open a new one.
			const {default: inspector} = await import('inspector');
			if (!options.debug.active || inspector.url() === undefined) {
				inspector.open(options.debug.port, options.debug.host, true);
			}

			if (options.debug.break) {
				debugger; // eslint-disable-line no-debugger
			}
		}

		await load(testPath);

		if (flags.loadedMain) {
			// Unreference the channel if the test file required AVA. This stops it
			// from keeping the event loop busy, which means the `beforeExit` event can be
			// used to detect when tests stall.
			channel.unref();
		} else {
			channel.send({type: 'missing-ava-import'});
			exit(1);
		}
	} catch (error) {
		channel.send({type: 'uncaught-exception', err: serializeError('Uncaught exception', true, error, runner.file)});
		exit(1);
	}
};

const onError = error => {
	// There shouldn't be any errors, but if there are we may not have managed
	// to bootstrap enough code to serialize them. Re-throw and let the process
	// crash.
	setImmediate(() => {
		throw error;
	});
};

if (isRunningInThread) {
	const {options} = workerData;
	delete workerData.options; // Don't allow user code access.
	run(options).catch(onError); // eslint-disable-line promise/prefer-await-to-then
} else if (isRunningInChildProcess) {
	channel.send({type: 'ready-for-options'});
	channel.options.then(run).catch(onError); // eslint-disable-line promise/prefer-await-to-then
}
