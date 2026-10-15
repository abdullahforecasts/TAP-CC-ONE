/**
 * TAP-CC-ONE VS Code extension entry point.
 * Author: Abdullah Nawaz. License: PolyForm Noncommercial 1.0.0.
 */
import type * as vscode from 'vscode';
import { Controller } from './vscode/controller.js';

let controller: Controller | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<Controller> {
  controller = new Controller(context);
  context.subscriptions.push(controller);
  await controller.activate();
  return controller;
}

export function deactivate(): void {
  controller?.deactivate();
  controller = undefined;
}
