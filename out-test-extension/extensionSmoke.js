"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// test/extension/extensionSmoke.ts
var extensionSmoke_exports = {};
__export(extensionSmoke_exports, {
  run: () => run
});
module.exports = __toCommonJS(extensionSmoke_exports);
var import_strict = __toESM(require("node:assert/strict"));
var vscode = __toESM(require("vscode"));
async function run() {
  const extension = vscode.extensions.getExtension("newdlops.git-simple-compare");
  import_strict.default.ok(extension, "Git Simple Compare extension manifest was not discovered by the Development Host.");
  await extension.activate();
  import_strict.default.equal(extension.isActive, true, "Git Simple Compare extension did not activate.");
  const commands2 = await vscode.commands.getCommands(true);
  import_strict.default.ok(commands2.includes("gitSimpleCompare.showChanges"), "Changes sidebar wrapper command was not registered.");
  import_strict.default.equal(commands2.includes("gitSimpleCompare.showReviews"), false, "Reviews sidebar wrapper command must not be registered.");
  await vscode.commands.executeCommand("gitSimpleCompare.showChanges");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  run
});
