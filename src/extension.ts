// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { getContentFromFilesystem, TestCase, testData, TestFile } from './test-tree';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "test-runner-sample-ext" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('test-runner-sample-ext.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from Test Runner Sample Ext!');
	});

	const _disposable = vscode.commands.registerCommand('test-runner-sample-ext.showCurrentTimeTest', () => {
		const date = new Date();
		const formatted = new Intl.DateTimeFormat("en-GB", {
			dateStyle: "medium",
			timeStyle: "long",
			timeZone: "Asia/Tbilisi",
		}).format(date);

		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Current time is: ' + formatted);
	});

	const testController = vscode.tests.createTestController("mathTestController", "Markdown Math Test Runner");

	const fileChangedEmitter = new vscode.EventEmitter<vscode.Uri>();
	const watchingTests = new Map<vscode.TestItem | "ALL", vscode.TestRunProfile | undefined>();
	fileChangedEmitter.event(uri => {
		if (watchingTests.has("ALL")) {
			startTestRun(testController, new vscode.TestRunRequest(undefined, undefined, watchingTests.get("ALL"), true));
			return;
		}

		const include: vscode.TestItem[] = [];
		let profile: vscode.TestRunProfile | undefined;
		for (const [item, thisProfile] of watchingTests) {
			const castedTestItem = item as vscode.TestItem;

			if (castedTestItem.uri?.toString() == uri.toString()) {
				include.push(castedTestItem);
				profile = thisProfile;
			}
		}

		if (include.length) {
			startTestRun(testController, new vscode.TestRunRequest(include, undefined, profile, true));
		}
	});

	const runHandler = (request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) => {
		if (!request.continuous) {
			return startTestRun(testController, request);
		}

		if (request.include === undefined) {
			watchingTests.set("ALL", request.profile);
			cancellation.onCancellationRequested(() => watchingTests.delete("ALL"));
		} else {
			request.include.forEach(item => watchingTests.set(item, request.profile));
			cancellation.onCancellationRequested(() => request.include!.forEach(item => watchingTests.delete(item)));
		}
	}


	context.subscriptions.push(...[disposable, _disposable, testController]);

	testController.refreshHandler = async () => {
		await Promise.all(getWorkspaceTestPatterns().map(({ pattern }) => findInitialFiles(testController, pattern)));
	}

	testController.createRunProfile("Run Tests", vscode.TestRunProfileKind.Run, runHandler, true, undefined, true);

	const coverageProfile = testController.createRunProfile("Run with Coverage", vscode.TestRunProfileKind.Coverage, runHandler, true, undefined, true);
	coverageProfile.loadDetailedCoverage = async (_testRun, coverage) => {
		if (coverage instanceof MarkdownFileCoverage) {
			return coverage.coveredLines.filter((l): l is vscode.StatementCoverage => !!l);
		}

		return [];
	}

	testController.resolveHandler = async item => {
		if (!item) {
			context.subscriptions.push(...startWatchingWorkspace(testController, fileChangedEmitter));
			return;
		}

		const data = testData.get(item);
		if (data instanceof TestFile) {
			await data.updateFromDisk(testController, item);
		}
	}

	function updateNodeFromDocument(e: vscode.TextDocument) {
		if (e.uri.scheme !== "file") {
			return;
		}

		if (!e.uri.path.endsWith('.md')) {
			return;
		}

		const { file, data } = getOrCreateFile(testController, e.uri);
		data.updateFromContents(testController, e.getText(), file);
	}

	for (const document of vscode.workspace.textDocuments) {
		updateNodeFromDocument(document);
	}

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(updateNodeFromDocument),
		vscode.workspace.onDidChangeTextDocument(e => updateNodeFromDocument(e.document))
	);
}

// This method is called when your extension is deactivated
export function deactivate() { }

function startTestRun(ctrl: vscode.TestController, request: vscode.TestRunRequest) {
	const queue: Array<{ test: vscode.TestItem, data: TestCase }> = [];
	const run = ctrl.createTestRun(request);
	const coveredLines = new Map</* file uri */ string, (vscode.StatementCoverage | undefined)[]>();

	const discoverTests = async (tests: Iterable<vscode.TestItem>) => {
		for (const test of tests) {
			if (request.exclude?.includes(test)) {
				continue;
			}

			const data = testData.get(test);
			if (data instanceof TestCase) {
				run.enqueued(test);
				queue.push({ test, data });
			} else {
				if (data instanceof TestFile && !data.didResolve) {
					await data.updateFromDisk(ctrl, test);
				}

				await discoverTests(gatherTestItems(test.children));
			}

			if (test.uri && !coveredLines.has(test.uri.toString()) && request.profile?.kind === vscode.TestRunProfileKind.Coverage) {
				try {
					const lines = (await getContentFromFilesystem(test.uri)).split("\n");

					coveredLines.set(
						test.uri.toString(),
						lines.map(
							(lineText, lineNo) => lineText.trim().length
								? new vscode.StatementCoverage(0, new vscode.Position(0, lineNo))
								: undefined
						)
					)
				}
				catch {
					// noop
					() => { }
				}
			}
		}
	}

	const runTestQueue = async () => {
		for (const { test, data } of queue) {
			run.appendOutput(`Running ${test.id}\r\n`);

			if (run.token.isCancellationRequested) {
				run.skipped(test);
			} else {
				run.started(test);
				await data.run(test, run);
			}

			const lienNo = test.range?.start.line;
			const fileCoverage = coveredLines.get(test.uri!.toString());
			const lineInfo = typeof lienNo === "undefined" ? null : fileCoverage?.[lienNo];

			if (lineInfo) {
				(lineInfo.executed as number)++
			}

			run.appendOutput(`Completed ${test.id}\r\n`);
		}

		for (const [uri, statements] of coveredLines) {
			run.addCoverage(new MarkdownFileCoverage(uri, statements));
		}

		run.end();
	}

	discoverTests(request.include ?? gatherTestItems(ctrl.items)).then(runTestQueue);
}

function gatherTestItems(collection: vscode.TestItemCollection) {
	const items: vscode.TestItem[] = [];
	collection.forEach((_item) => items.push(_item));

	return items;
}

function getWorkspaceTestPatterns() {
	if (!vscode.workspace.workspaceFolders) {
		return [];
	}

	return vscode.workspace.workspaceFolders.map(workspaceFolder => ({
		workspaceFolder,
		pattern: new vscode.RelativePattern(workspaceFolder, '**/*.md')
	}));
}

async function findInitialFiles(controller: vscode.TestController, pattern: vscode.GlobPattern) {
	for (const file of await vscode.workspace.findFiles(pattern)) {
		getOrCreateFile(controller, file);
	}
}

function getOrCreateFile(controller: vscode.TestController, uri: vscode.Uri) {
	const existing = controller.items.get(uri.toString());
	if (existing) {
		return {
			file: existing,
			data: testData.get(existing) as TestFile
		};
	}

	const file = controller.createTestItem(uri.toString(), uri.path.split("/").pop()!, uri);
	controller.items.add(file);

	const data = new TestFile();
	testData.set(file, data);

	file.canResolveChildren = true;
	return { file, data };
}

function startWatchingWorkspace(controller: vscode.TestController, fileChangedEmitter: vscode.EventEmitter<vscode.Uri>) {
	return getWorkspaceTestPatterns().map(({ pattern }) => {
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);

		watcher.onDidCreate(uri => {
			getOrCreateFile(controller, uri);
			fileChangedEmitter.fire(uri);
		});
		watcher.onDidChange(async uri => {
			const { file, data } = getOrCreateFile(controller, uri);
			if (data.didResolve) {
				await data.updateFromDisk(controller, file);
			}
			fileChangedEmitter.fire(uri);
		});

		findInitialFiles(controller, pattern);

		return watcher;
	});
}


class MarkdownFileCoverage extends vscode.FileCoverage {
	public readonly coveredLines;

	constructor(uri: string, coveredLines: (vscode.StatementCoverage | undefined)[]) {
		super(vscode.Uri.parse(uri), new vscode.TestCoverageCount(0, 0));

		this.coveredLines = coveredLines;

		for (const line of coveredLines) {
			if (line) {
				this.statementCoverage.covered += (line.executed ? 1 : 0);
				this.statementCoverage.total++;
			}
		}
	}
}