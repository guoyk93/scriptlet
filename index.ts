/**
 * index.ts
 *
 * Copyright (c) 2019 Guo Y.K. <hi@guoyk.net>
 *
 * This software is released under the MIT License.
 * https://opensource.org/licenses/MIT
 */

import fs = require("fs-extra");
import path = require("path");
import vm = require("vm");

interface ISandbox {
  define: (...args: any[]) => void;
  deps: string[];
  object: any;
}

/** reusable sandbox for scriptlet definition */
const sandbox = {
  define(...args: any[]) {
    // AMD like , `define(['depA', 'depB'], function(depA, depB) {})`
    if (args.length === 2 && Array.isArray(args[0])) {
      args[0].push(args[1]);
      args = args[0];
    }
    sandbox.object = args.pop();
    sandbox.deps = args;
  },
  deps: [],
  object: null,
} as ISandbox;

/** reusable vm.Context for scriptlet definition */
const sandboxContext = vm.createContext(sandbox);

/** mtime based scriptlet file cache policy */
export const MTIME = "mtime";
/** error code - dependency loop detected */
export const ERR_DEPENDENCY_LOOP = "ERR_DEPENDENCY_LOOP";
/** error code - missing dependency */
export const ERR_DEPENDENCY_MISSING = "ERR_DEPENDENCY_MISSING";

/** all cached scripts */
export const cachedScriptlets: Map<string, ICachedScriptlet> = new Map();

/** cached script */
export interface ICachedScriptlet {
  /** full path for scriptlet */
  fullPath: string;
  /** mtime in milisecond of scriptlet file */
  mtimeMs: number;
  /** compiled vm.Script */
  script: vm.Script;
}

/** scriptlet execution option */
export interface IScriptletOption {
  /**
   * extra dependencies for script, key prefixed with '$' is strongly suggested
   */
  extra?: Map<string, any>;
  /**
   * cache policy, true for full cache, false for none cache, 'mtime' for
   * mtime based file cache, default to 'false'
   */
  cache?: boolean | string;
  /**
   * internal tracker for dependency loop detection
   */
  _loopTracker?: Set<string>;
}

export class ScriptletError extends Error {
  public code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * clone a scriptlet option, keeps '_loopTracker' reference, but clone 'extra',
 * preventing lower level extra modification overrides upper level
 * @param option scriptlet option
 */
function cloneScriptletOption(
  option: IScriptletOption, moreExtra?: Map<string, any>): IScriptletOption {
  const newOption = {} as IScriptletOption;
  newOption.cache = option.cache;
  newOption._loopTracker = option._loopTracker;
  if (option.extra || moreExtra) {
    newOption.extra = new Map<string, any>();
    if (option.extra) {
      for (const entry of option.extra) {
        newOption.extra.set(entry[0], entry[1]);
      }
    }
    if (moreExtra) {
      for (const entry of moreExtra) {
        newOption.extra.set(entry[0], entry[1]);
      }
    }
  }
  return newOption;
}

/**
 * resolve a relative scriptlet path
 * @param fullPath fullpath of the scriptlet
 * @param name relative name of target scriptlet
 */
function resolveRelativeScriptlet(fullPath: string, name: string): string {
  return path.resolve(path.dirname(fullPath), name + ".js");
}

/**
 * run a scriptlet
 * @param id scriptlet file to run
 * @param option scriptlet execution option
 */
export async function run(
  file: string, option: IScriptletOption = {}): Promise<any> {
  // resolve full path
  const fullPath = path.resolve(file);
  // check dependency loop
  option._loopTracker = option._loopTracker || new Set();
  if (option._loopTracker.has(fullPath)) {
    throw new ScriptletError(
      ERR_DEPENDENCY_LOOP, `dependency loop detected in ${file}`);
  }
  option._loopTracker.add(fullPath);
  // apply cache policy
  let script = null;
  let stat = null;
  if (option.cache) {
    const cached = cachedScriptlets.get(fullPath);
    if (cached) {
      if (option.cache === "mtime") {
        stat = await fs.stat(fullPath);
        if (stat.mtimeMs === cached.mtimeMs) {
          script = cached.script;
        }
      } else {
        script = cached.script;
      }
    }
  }
  // read script if not cached
  if (!script) {
    const content = await fs.readFile(fullPath, "utf8");
    script =
      new vm.Script(content, { filename: fullPath, produceCachedData: true });
    if (!stat) {
      stat = await fs.stat(fullPath);
    }
    cachedScriptlets.set(fullPath, { fullPath, mtimeMs: stat.mtimeMs, script });
  }
  // evaluate the script
  sandbox.deps = [];
  sandbox.object = null;
  script.runInContext(sandboxContext);
  const { deps, object } = sandbox;
  // resolve dependencies
  const args = [];
  for (const dep of deps) {
    if (dep === "$load") {
      // buildtin $load function
      args.push(async (name: string, extra?: Map<string, any>) => {
        return run(
          resolveRelativeScriptlet(fullPath, name),
          cloneScriptletOption(option, extra));
      });
    } else if (option.extra && option.extra.has(dep)) {
      // option.extra contains that dep, key prefixed with $ is suggested
      args.push(option.extra.get(dep));
    } else if (dep.startsWith(".")) {
      // relative scriptlet
      args.push(await run(
        resolveRelativeScriptlet(fullPath, dep),
        cloneScriptletOption(option)));
    } else {
      // node.js require()
      try {
        args.push(require(dep));
      } catch (e) {
        throw new ScriptletError(
          ERR_DEPENDENCY_MISSING,
          `failed to resolve dependency ${dep} in script ${fullPath}`);
      }
    }
  }
  if (typeof object === "function") {
    return object(...args);
  } else {
    return object;
  }
}
