/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

//@ts-check
const path = require('path');
const os = require('os');
const {devices} = require('../..');
const Documentation = require('../doclint/documentation');
const PROJECT_DIR = path.join(__dirname, '..', '..');
const fs = require('fs');
const {parseOverrides} = require('./parseOverrides');
const exported = require('./exported.json');
const { parseApi } = require('../doclint/api_parser');

const objectDefinitions = [];
const handledMethods = new Set();
/** @type {Documentation} */
let documentation;
let hadChanges = false;

(async function() {
  const typesDir = path.join(PROJECT_DIR, 'types');
  if (!fs.existsSync(typesDir))
    fs.mkdirSync(typesDir)
  writeFile(path.join(typesDir, 'protocol.d.ts'), fs.readFileSync(path.join(PROJECT_DIR, 'src', 'server', 'chromium', 'protocol.ts'), 'utf8'));
  documentation = parseApi(path.join(PROJECT_DIR, 'docs', 'src', 'api'));
  documentation.filterForLanguage('js');
  documentation.copyDocsFromSuperclasses([]);
  const createMemberLink = (text) => {
    const anchor = text.toLowerCase().split(',').map(c => c.replace(/[^a-z]/g, '')).join('-');
    return `[${text}](https://github.com/microsoft/playwright/blob/master/docs/api.md#${anchor})`;
  };
  documentation.setLinkRenderer(item => {
    const { clazz, member, param, option } = item;
    if (param)
      return `\`${param}\``;
    if (option)
      return `\`${option}\``;
    if (clazz)
      return `[${clazz.name}]`;
    if (member.kind === 'method')
      return createMemberLink(`${member.clazz.varName}.${member.name}(…)`);
    if (member.kind === 'event')
      return createMemberLink(`${member.clazz.varName}.on('${member.name}')`);
    if (member.kind === 'property')
      return createMemberLink(`${member.clazz.varName}.${member.name}`);
    throw new Error('Unknown member kind ' + member.kind);
  });
  documentation.generateSourceCodeComments();

  // Root module types are overridden.
  const playwrightClass = documentation.classes.get('Playwright');
  documentation.classes.delete('Playwright');
  documentation.classesArray.splice(documentation.classesArray.indexOf(playwrightClass), 1);

  const handledClasses = new Set();

  function docClassForName(name) {
    const docClass = documentation.classes.get(name);
    if (!docClass)
      throw new Error(`Unknown override class "${name}"`);
    return docClass;
  }
  const overrides = await parseOverrides(className => {
    handledClasses.add(className);
    return writeComment(docClassForName(className).comment) + '\n';
  }, (className, methodName) => {
    const docClass = docClassForName(className);
    const method = docClass.methods.get(methodName);
    handledMethods.add(`${className}.${methodName}`);
    if (!method) {
      if (new Set(['on', 'addListener', 'off', 'removeListener', 'once']).has(methodName))
        return '';
      throw new Error(`Unknown override method "${className}.${methodName}"`);
    }
    return memberJSDOC(method, '  ').trimLeft();
  }, (className) => {
    return classBody(docClassForName(className));
  });
  const classes = documentation.classesArray.filter(cls => !handledClasses.has(cls.name));
  let output = `// This file is generated by ${__filename.substring(path.join(__dirname, '..', '..').length).split(path.sep).join(path.posix.sep)}
${overrides}

${classes.map(classDesc => classToString(classDesc)).join('\n')}
${objectDefinitionsToString(overrides)}
${generateDevicesTypes()}
`;
  for (const [key, value] of Object.entries(exported))
    output = output.replace(new RegExp('\\b' + key + '\\b', 'g'), value);
  writeFile(path.join(typesDir, 'types.d.ts'), output);
  process.exit(hadChanges && process.argv.includes('--check-clean') ? 1 : 0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});

function writeFile(filePath, content) {
  if (os.platform() === 'win32')
    content = content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const existing = fs.readFileSync(filePath, 'utf8');
  if (existing === content)
    return;
  hadChanges = true;
  console.error(`Writing //${path.relative(PROJECT_DIR, filePath)}`);
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * @param {string} overriddes
 */
function objectDefinitionsToString(overriddes) {
  let definition;
  const parts = [];
  const internalWords = new Set(overriddes.split(/[^\w$]/g));
  while ((definition = objectDefinitions.pop())) {
    const {name, properties} = definition;
    const shouldExport = !!exported[name];
    const usedInternally = internalWords.has(name);
    if (!usedInternally && !shouldExport)
      continue;
    parts.push(`${shouldExport ? 'export ' : ''}interface ${name} ${stringifyObjectType(properties, name, '')}\n`)
  }
  return parts.join('\n');
}

function nameForProperty(member) {
  return (member.required || member.name.startsWith('...')) ? member.name : member.name + '?';
}

/**
 * @param {Documentation.Class} classDesc
 */
function classToString(classDesc) {
  const parts = [];
  if (classDesc.comment) {
    parts.push(writeComment(classDesc.comment))
  }
  parts.push(`export interface ${classDesc.name} ${classDesc.extends ? `extends ${classDesc.extends} ` : ''}{`);
  parts.push(classBody(classDesc));
  parts.push('}\n');
  return parts.join('\n');
}

/**
 * @param {string} type
 */
function argNameForType(type) {
  if (type === 'void')
    return null;
  if (type.includes('{'))
    return 'data';
  return (type[0].toLowerCase() + type.slice(1)).replace(/\|/g, 'Or');
}

/**
 * @param {Documentation.Class} classDesc
 */
function hasUniqueEvents(classDesc) {
  if (!classDesc.events.size)
    return false;
  const parent = parentClass(classDesc);
  if (!parent)
    return true;
  return Array.from(classDesc.events.keys()).some(eventName => !parent.events.has(eventName));
}

/**
 * @param {Documentation.Class} classDesc
 */
function createEventDescriptions(classDesc) {
  if (!hasUniqueEvents(classDesc))
    return [];
  const descriptions = [];
  for (const [eventName, value] of classDesc.events) {
    const type = stringifyComplexType(value && value.type, '', classDesc.name, eventName, 'payload');
    const argName = argNameForType(type);
    const params = argName ? `${argName}: ${type}` : '';
    descriptions.push({
      type,
      params,
      eventName,
      comment: value.comment
    });
  }
  return descriptions;
}

/**
 * @param {Documentation.Class} classDesc
 */
function classBody(classDesc) {
  const parts = [];
  const eventDescriptions = createEventDescriptions(classDesc);
  for (const method of ['on', 'once', 'addListener', 'removeListener', 'off']) {
    for (const {eventName, params, comment} of eventDescriptions) {
        if (comment)
          parts.push(writeComment(comment, '  '));
        parts.push(`  ${method}(event: '${eventName}', listener: (${params}) => void): this;\n`);
    }
  }

  const members = classDesc.membersArray.filter(member => member.kind !== 'event');
  parts.push(members.map(member => {
    if (member.kind === 'event')
      return '';
    if (member.name === 'waitForEvent') {
      const parts = [];
      for (const {eventName, params, comment, type} of eventDescriptions) {
        if (comment)
          parts.push(writeComment(comment, '  '));
        parts.push(`  ${member.name}(event: '${eventName}', optionsOrPredicate?: { predicate?: (${params}) => boolean, timeout?: number } | ((${params}) => boolean)): Promise<${type}>;\n`);
      }

      return parts.join('\n');
    }
    const jsdoc = memberJSDOC(member, '  ');
    const args = argsFromMember(member, '  ', classDesc.name);
    let type = stringifyComplexType(member.type, '  ', classDesc.name, member.name);
    if (member.async)
      type = `Promise<${type}>`;
    // do this late, because we still want object definitions for overridden types
    if (!hasOwnMethod(classDesc, member.name))
      return '';
    return `${jsdoc}${member.name}${args}: ${type};`
  }).filter(x => x).join('\n\n'));
  return parts.join('\n');
}

/**
 * @param {Documentation.Class} classDesc
 * @param {string} methodName
 */
function hasOwnMethod(classDesc, methodName) {
  if (handledMethods.has(`${classDesc.name}.${methodName}`))
    return false;
  while (classDesc = parentClass(classDesc)) {
    if (classDesc.members.has(methodName))
      return false;
  }
  return true;
}

/**
 * @param {Documentation.Class} classDesc
 */
function parentClass(classDesc) {
  if (!classDesc.extends)
    return null;
  return documentation.classes.get(classDesc.extends);
}

function writeComment(comment, indent = '') {
  const parts = [];
  const out = [];
  const pushLine = (line) => {
    if (line || out[out.length - 1])
      out.push(line)
  };
  let skipExample = false;
  for (let line of comment.split('\n')) {
    const match = line.match(/```(\w+)/);
    if (match) {
      const lang = match[1];
      skipExample = !["html", "yml", "sh", "js"].includes(lang);
    } else if (skipExample && line.trim().startsWith('```')) {
      skipExample = false;
      continue;
    }
    if (!skipExample)
      pushLine(line);
  }
  comment = out.join('\n');
  comment = comment.replace(/\[`([^`]+)`\]\(#([^\)]+)\)/g, '[$1](https://github.com/microsoft/playwright/blob/master/docs/api.md#$2)');
  comment = comment.replace(/\[([^\]]+)\]\(#([^\)]+)\)/g, '[$1](https://github.com/microsoft/playwright/blob/master/docs/api.md#$2)');
  comment = comment.replace(/\[`([^`]+)`\]\(\.\/([^\)]+)\)/g, '[$1](https://github.com/microsoft/playwright/blob/master/docs/$2)');
  comment = comment.replace(/\[([^\]]+)\]\(\.\/([^\)]+)\)/g, '[$1](https://github.com/microsoft/playwright/blob/master/docs/$2)');

  parts.push(indent + '/**');
  parts.push(...comment.split('\n').map(line => indent + ' * ' + line.replace(/\*\//g, '*\\/')));
  parts.push(indent + ' */');
  return parts.join('\n');
}

/**
 * @param {Documentation.Type} type
 */
function stringifyComplexType(type, indent, ...namespace) {
  if (!type)
    return 'void';
  return stringifySimpleType(type, indent, ...namespace);
}

function stringifyObjectType(properties, name, indent = '') {
  const parts = [];
  parts.push(`{`);
  parts.push(properties.map(member => `${memberJSDOC(member, indent + '  ')}${nameForProperty(member)}${argsFromMember(member, indent + '  ', name)}: ${stringifyComplexType(member.type, indent + '  ',  name, member.name)};`).join('\n\n'));
  parts.push(indent + '}');
  return parts.join('\n');
}

/**
 * @param {Documentation.Type=} type
 * @returns{string}
 */
function stringifySimpleType(type, indent = '', ...namespace) {
  if (!type)
    return 'void';
  if (type.name === 'Object' && type.templates) {
    const keyType = stringifySimpleType(type.templates[0], indent, ...namespace);
    const valueType = stringifySimpleType(type.templates[1], indent, ...namespace);
    return `{ [key: ${keyType}]: ${valueType}; }`;
  }
  let out = type.name;
  if (out === 'int' || out === 'float')
    out = 'number';

  if (type.name === 'Object' && type.properties && type.properties.length) {
    const name = namespace.map(n => n[0].toUpperCase() + n.substring(1)).join('');
    const shouldExport = exported[name];
    objectDefinitions.push({name, properties: type.properties});
    if (shouldExport) {
      out = name;
    } else {
      out = stringifyObjectType(type.properties, name, indent);
    }
  }

  if (type.args) {
    const stringArgs = type.args.map(a => ({
      type: stringifySimpleType(a, indent, ...namespace),
      name: a.name.toLowerCase()
    }));
    out = `((${stringArgs.map(({name, type}) => `${name}: ${type}`).join(', ')}) => ${stringifySimpleType(type.returnType, indent, ...namespace)})`;
  } else if (type.name === 'function') {
    out = 'Function';
  }
  if (out === 'path')
    return 'string';
  if (out === 'Any')
    return 'any';
  if (type.templates)
    out += '<' + type.templates.map(t => stringifySimpleType(t, indent, ...namespace)).join(', ') + '>';
  if (type.union)
    out = type.union.map(t => stringifySimpleType(t, indent, ...namespace)).join('|');
  return out.trim();
}

/**
 * @param {Documentation.Member} member
 */
function argsFromMember(member, indent, ...namespace) {
  if (member.kind === 'property')
    return '';
  return '(' + member.argsArray.map(arg => `${nameForProperty(arg)}: ${stringifyComplexType(arg.type, indent, ...namespace, member.name, arg.name)}`).join(', ') + ')';
}
/**
 * @param {Documentation.Member} member
 * @param {string} indent
 */
function memberJSDOC(member, indent) {
  const lines = [];
  if (member.comment)
    lines.push(...member.comment.split('\n'));
  if (member.deprecated)
    lines.push('@deprecated');
  lines.push(...member.argsArray.map(arg => `@param ${arg.name.replace(/\./g, '')} ${arg.comment.replace('\n', ' ')}`));
  if (!lines.length)
    return indent;
  return writeComment(lines.join('\n'), indent) + '\n' + indent;
}

function generateDevicesTypes() {
  const namedDevices =
    Object.keys(devices)
      .map(name => `  ${JSON.stringify(name)}: DeviceDescriptor;`)
      .join('\n');
  return `type Devices = {
${namedDevices}
  [key: string]: DeviceDescriptor;
}`;
}
