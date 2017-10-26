// Copyright 2017 The Serulian Authors. All rights reserved.
// Use of this source code (unless otherwise stated) is governed by a BSD-style
// license that can be found in the LICENSE file.

// As noted below, small portions of this file are copied from or based on the https://github.com/Microsoft/vscode-go and
// https://github.com/OmniSharp/omnisharp-vscode projects. As required, their license is included below:
// ===========================================================================
// Copyright (c) Microsoft Corporation

// All rights reserved.

// MIT License

// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation
// files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy,
// modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software
// is furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
// ===========================================================================


'use strict';

import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import * as https from 'https';
import * as mkdirp from 'mkdirp';
import { parse as parseUrl } from 'url';

import { extensions, workspace, Disposable, ExtensionContext, Uri, StatusBarAlignment, window, OutputChannel, StatusBarItem } from 'vscode';
import { LanguageClient, LanguageClientOptions, SettingMonitor, ServerOptions, TransportKind } from 'vscode-languageclient';

import fs = require('fs');

const DEFAULT_LANGUAGE_SERVER_PATH = 'tools/serulian-langserver';

// From: https://github.com/Microsoft/vscode-go/blob/master/src/goPath.ts
function fileExists(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch (e) {
		return false;
	}
}

// From: https://github.com/OmniSharp/omnisharp-vscode/blob/master/src/common.ts
function execChildProcess(command: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        cp.exec(command, { maxBuffer: 500 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            }
            else if (stderr && stderr.length > 0) {
                reject(new Error(stderr));
            }
            else {
                resolve(stdout);
            }
        });
    });
}

var supportedPlatforms = {
	'darwin': {
		'x86_64': 'darwin-amd64'
	},
	'linux': {
		'x86_64': 'linux-amd64',
	},
	'windows': { 
		'x86_64': 'windows-amd64',
	}
}

function downloadAndInstallSerulianLanguageServer(): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let platform = os.platform().toString();
		if (!supportedPlatforms[platform]) {
			reject(`Serulian Language Server is not supported on platform \`${platform}\``);
			return;
		}

		if (platform != 'windows') {
			execChildProcess('uname -m').then((arch) => {
				arch = arch.trim();

				if (!supportedPlatforms[platform][arch]) {
					reject(`Serulian Language Server is not supported on platform \`${platform}\` with arch \`${arch}\`.`);
					return;
				}

				downloadAndInstallForPlatform(platform, arch).then(resolve, reject);
			}, () => {
				reject('Could not determine platform');
			});
		} else {
			downloadAndInstallForPlatform('windows', 'x86_64').then(resolve, reject);
		}
	});
}

function downloadAndInstallForPlatform(platform: string, arch: string): Promise<void> {
	let extension = extensions.getExtension('serulian.serulian');
	let extensionPath = extension.extensionPath;
	let toolkitVersion = extension.packageJSON['toolkitVersion'];

	let binary = `serulian-langserver-${supportedPlatforms[platform][arch]}`;
	let downloadUrl = `https://github.com/Serulian/serulian-langserver/releases/download/v${toolkitVersion}/${binary}`;

	let fullLangBinaryPath = path.join(extensionPath, DEFAULT_LANGUAGE_SERVER_PATH);

	let consoleChannel = window.createOutputChannel('Serulian');

	let statusView = window.createStatusBarItem(StatusBarAlignment.Right);
	statusView.text = "Download Serulian Language Server"
	statusView.show()

	return new Promise<void>((resolve, reject) => {
		// Make the tools path, if not present.
		mkdirp(path.dirname(fullLangBinaryPath), function(err) {
			if (err) {
				reject(err);
				return;
			}

			consoleChannel.appendLine(`Beginning download of ${downloadUrl}`)
			downloadFile(fullLangBinaryPath, downloadUrl, consoleChannel, statusView).then(function() {
				// Mark the downloaded binary as executable.
				fs.chmod(fullLangBinaryPath, 0o755, function(err) {
					if (err) {
						reject(err.message);
						return;
					}

					resolve();
				});
			}, reject);
		});
	});
}

function downloadFile(fullBinaryPath: string, downloadUrl: string, consoleChannel: OutputChannel, statusView: StatusBarItem): Promise<void> {
	// Based on: https://github.com/OmniSharp/omnisharp-vscode/blob/master/src/packages.ts#L222
	let langBinary = fs.createWriteStream(fullBinaryPath);
	langBinary.on('finish', function() {
		langBinary.close();
	});

	return new Promise<void>((resolve, reject) => {
		const url = parseUrl(downloadUrl);
		const options: https.RequestOptions = {
			host: url.host,
			path: url.path,
		};

		let request = https.request(options, response => {
			if (response.statusCode != 200) {
				if (response.statusCode === 301 || response.statusCode === 302) {
					// Follow the redirect.
               	  	return resolve(downloadFile(fullBinaryPath, response.headers.location, consoleChannel, statusView));
				}

				consoleChannel.appendLine(`Could not download Serulian Language Server: ${response.statusCode}`)
				reject(`Could not download Serulian Language Server: ${response.statusCode}`);
				return;
			}

			let binarySize = parseInt(response.headers['content-length'], 10);
			let downloadedBytes = 0;
			let downloadPercentage = 0;
 			let dots = 0;

			response.on('data', data => {
                downloadedBytes += data.length;

                // Update status bar item with percentage.
                let newPercentage = Math.ceil(100 * (downloadedBytes / binarySize));
                if (newPercentage !== downloadPercentage) {
                    downloadPercentage = newPercentage;

                    statusView.text = `Downloading... ${downloadPercentage}%`;
					statusView.show();
                }

                // Update dots after package name in output console.
                let newDots = Math.ceil(downloadPercentage / 5);
                if (newDots > dots) {
                    consoleChannel.append('.'.repeat(newDots - dots));
                    dots = newDots;
                }
			});

            response.on('error', err => {
				consoleChannel.appendLine("")
				consoleChannel.appendLine('Download failed :(')
				fs.unlink(fullBinaryPath);
            	reject(err.message);
			});

			response.on('end', () => {
				consoleChannel.appendLine("")
				consoleChannel.appendLine('Download complete!')
				resolve();
			});

			// Pipe the downloading binary to the final location.
			response.pipe(langBinary, { end: false });
		});

		request.on('error', err => {
            reject(err.message);
		});

		// Execute the download request.
		request.end();
	});
}

export function activate(context: ExtensionContext) {
	var configuration = workspace.getConfiguration('serulian');
	let extension = extensions.getExtension('serulian.serulian');
	let extensionPath = extension.extensionPath;
	let defaultPath = path.join(extensionPath, DEFAULT_LANGUAGE_SERVER_PATH);

	// Check for a custom language server.
	if (configuration['langServerPath']) {
		if (!fileExists(configuration['langServerPath'])) {
			window.showErrorMessage(`Custom Serulian Language Server not found at path \`${configuration['langServerPath']}\``);
			return;
		}
	} else {
		// Check for the default language server.
		if (!fileExists(defaultPath)) {
			window.showInformationMessage(`Serulian Language Server is not available. Download and install now?`, 'Install').then(selected => {
				if (selected === 'Install') {
					downloadAndInstallSerulianLanguageServer().then(function() {
						window.showInformationMessage('Serulian Language Server installed! Please restart your window.')
					}).catch(function(err) {
						window.showErrorMessage(err);
					});
				} else {
					window.showWarningMessage('Serulian language integration will be disabled until the language server is installed');
				}
			});
			return;
		}
	}

	let version = extension.packageJSON['version'];
	let toolkitVersion = extension.packageJSON['toolkitVersion'];
	let statusView = window.createStatusBarItem(StatusBarAlignment.Right);
	statusView.text = `${version} | ${toolkitVersion}`;
	statusView.show()

	let langServerPath = configuration['langServerPath'] || defaultPath;
	let args = ['run'];
	if (configuration['langServerDebug']) {
		args.push('--debug');
	}
	if (configuration['langServerProfile']) {
		args.push('--profile');
	}

	let workspaceRootPath = workspace.rootPath;
	if (configuration['entrypointSourceFile']) {
		var entrypointPath = path.join(workspaceRootPath, configuration['entrypointSourceFile']);
		if (fileExists(entrypointPath)) {
			args.push('--entrypointSourceFile');
			args.push(entrypointPath);
		} else {
			window.showWarningMessage(`Configured entrypoint source file \`${entrypointPath}\` does not exist`);			
		}
	}

	if (configuration['vcsDevelopmentDirectories']) {
		configuration['vcsDevelopmentDirectories'].forEach((devDir) => {
			args.push('--vcs-dev-dir');
			args.push(path.join(workspaceRootPath, devDir));
		});
	}

	const client = new LanguageClient(
		'serulian-langserver',
		{
			command: langServerPath,
			args: args,
		},
		{
			documentSelector: ['serulian', 'webidl'],
			uriConverters: {
				// Apply file:/// scheme to all file paths.
				code2Protocol: (uri: Uri): string => (uri.scheme ? uri : uri.with({ scheme: 'file' })).toString(),
				protocol2Code: (uri: string) => Uri.parse(uri),
			},
		}
	);

	context.subscriptions.push(client.start());
}