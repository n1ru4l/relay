/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

'use strict';

const IRTransformer = require('../core/GraphQLIRTransformer');

const getLiteralArgumentValues = require('../core/getLiteralArgumentValues');
const getNormalizationOperationName = require('../core/getNormalizationOperationName');

const {createUserError} = require('../core/RelayCompilerError');
const {getModuleComponentKey, getModuleOperationKey} = require('relay-runtime');

import type CompilerContext from '../core/GraphQLCompilerContext';
import type {
  InlineFragment,
  FragmentSpread,
  LinkedField,
  ScalarField,
} from '../core/GraphQLIR';
import type {TypeID} from '../core/Schema';

const SUPPORTED_ARGUMENT_NAME = 'supported';

const JS_FIELD_TYPE = 'JSDependency';
const JS_FIELD_MODULE_ARG = 'module';
const JS_FIELD_ID_ARG = 'id';
const JS_FIELD_NAME = 'js';

const SCHEMA_EXTENSION = `
  directive @match on FIELD

  directive @module(
    name: String!
  ) on FRAGMENT_SPREAD
`;

type State = {|
  +documentName: string,
  +path: Array<string>,
  +parentType: TypeID,
|};

/**
 * This transform rewrites LinkedField nodes with @match and rewrites them
 * into `LinkedField` nodes with a `supported` argument.
 */
function relayMatchTransform(context: CompilerContext): CompilerContext {
  return IRTransformer.transform(
    context,
    {
      // TODO: type IRTransformer to allow changing result type
      FragmentSpread: (visitFragmentSpread: $FlowFixMe),
      LinkedField: visitLinkedField,
      InlineFragment: visitInlineFragment,
      ScalarField: visitScalarField,
    },
    node => ({documentName: node.name, parentType: node.type, path: []}),
  );
}

function visitInlineFragment(
  node: InlineFragment,
  state: State,
): InlineFragment {
  return this.traverse(node, {
    ...state,
    parentType: node.typeCondition,
  });
}

function visitScalarField(field: ScalarField): ScalarField {
  const context: CompilerContext = this.getContext();
  const schema = context.getSchema();

  if (field.name === JS_FIELD_NAME) {
    const jsModuleType = schema.getTypeFromString(JS_FIELD_TYPE);
    if (jsModuleType == null || !schema.isServerType(jsModuleType)) {
      throw new createUserError(
        `'${JS_FIELD_NAME}' should be defined on the server schema.`,
        [field.loc],
      );
    }

    if (
      schema.isScalar(jsModuleType) &&
      schema.areEqualTypes(schema.getRawType(field.type), jsModuleType)
    ) {
      throw new createUserError(
        `Direct use of the '${JS_FIELD_NAME}' field is not allowed, use ` +
          '@match/@module instead.',
        [field.loc],
      );
    }
  }
  return field;
}

function visitLinkedField(node: LinkedField, state: State): LinkedField {
  const context: CompilerContext = this.getContext();
  const schema = context.getSchema();

  state.path.push(node.alias);
  const transformedNode: LinkedField = this.traverse(node, {
    ...state,
    parentType: node.type,
  });
  state.path.pop();

  const matchDirective = transformedNode.directives.find(
    directive => directive.name === 'match',
  );
  if (matchDirective == null) {
    return transformedNode;
  }

  const {parentType} = state;
  const rawType = schema.getRawType(parentType);
  if (!(schema.isInterface(rawType) || schema.isObject(rawType))) {
    throw createUserError(
      `@match used on incompatible field '${transformedNode.name}'.` +
        '@match may only be used with fields whose parent type is an ' +
        `interface or object, got invalid type '${schema.getTypeString(
          parentType,
        )}'.`,
      [node.loc],
    );
  }

  const currentField = schema.getFieldConfig(
    schema.expectField(
      schema.assertCompositeType(rawType),
      transformedNode.name,
    ),
  );

  const supportedArgumentDefinition = currentField.args.find(
    ({name}) => name === SUPPORTED_ARGUMENT_NAME,
  );

  const supportedArgType =
    supportedArgumentDefinition != null
      ? schema.getNullableType(supportedArgumentDefinition.type)
      : null;
  const supportedArgOfType =
    supportedArgType != null && schema.isList(supportedArgType)
      ? schema.getListItemType(supportedArgType)
      : null;
  if (
    supportedArgumentDefinition == null ||
    supportedArgType == null ||
    supportedArgOfType == null ||
    !schema.isString(schema.getNullableType(supportedArgOfType))
  ) {
    throw createUserError(
      `@match used on incompatible field '${transformedNode.name}'. ` +
        '@match may only be used with fields that accept a ' +
        "'supported: [String!]!' argument.",
      [node.loc],
    );
  }

  const rawFieldType = schema.getRawType(transformedNode.type);

  if (!schema.isAbstractType(rawFieldType)) {
    throw createUserError(
      `@match used on incompatible field '${transformedNode.name}'.` +
        '@match may only be used with fields that return a union or interface.',
      [node.loc],
    );
  }

  const seenTypes: Map<TypeID, InlineFragment> = new Map();
  const selections = [];
  transformedNode.selections.forEach(matchSelection => {
    if (
      matchSelection.kind === 'ScalarField' &&
      matchSelection.name === '__typename'
    ) {
      selections.push(matchSelection);
      return;
    }
    const moduleImport =
      matchSelection.kind === 'InlineFragment'
        ? matchSelection.selections[0]
        : null;
    if (
      matchSelection.kind !== 'InlineFragment' ||
      moduleImport == null ||
      moduleImport.kind !== 'ModuleImport'
    ) {
      throw createUserError(
        'Invalid @match selection: all selections should be ' +
          'fragment spreads with @module.',
        [matchSelection.loc],
      );
    }
    const matchedType = matchSelection.typeCondition;
    const previousTypeUsage = seenTypes.get(matchedType);
    if (previousTypeUsage) {
      throw createUserError(
        'Invalid @match selection: each concrete variant/implementor of ' +
          `'${schema.getTypeString(
            rawFieldType,
          )}' may be matched against at-most once, ` +
          `but '${schema.getTypeString(
            matchedType,
          )}' was matched against multiple times.`,
        [matchSelection.loc, previousTypeUsage.loc],
      );
    }
    seenTypes.set(matchedType, matchSelection);
    selections.push(matchSelection);
  });

  if (seenTypes.size === 0) {
    throw createUserError(
      'Invalid @match selection: expected at least one @module selection. ' +
        "Remove @match or add a '...Fragment @module()' selection.",
      [matchDirective.loc],
    );
  }

  const supportedArg = transformedNode.args.find(
    arg => arg.name === SUPPORTED_ARGUMENT_NAME,
  );
  if (supportedArg != null) {
    throw createUserError(
      `Invalid @match selection: the '${SUPPORTED_ARGUMENT_NAME}' argument ` +
        'is automatically added and cannot be supplied explicitly.',
      [supportedArg.loc],
    );
  }

  return {
    kind: 'LinkedField',
    alias: transformedNode.alias,
    args: [
      ...transformedNode.args,
      {
        kind: 'Argument',
        name: SUPPORTED_ARGUMENT_NAME,
        type: supportedArgumentDefinition.type,
        value: {
          kind: 'Literal',
          loc: node.loc,
          value: Array.from(seenTypes.keys()).map(type =>
            schema.getTypeString(type),
          ),
        },
        loc: node.loc,
      },
    ],
    connection: false,
    directives: [],
    handles: null,
    loc: node.loc,
    metadata: null,
    name: transformedNode.name,
    type: transformedNode.type,
    selections,
  };
}

// Transform @module
function visitFragmentSpread(
  spread: FragmentSpread,
  {documentName, path}: State,
): FragmentSpread | InlineFragment {
  const transformedNode: FragmentSpread = this.traverse(spread);

  const moduleDirective = transformedNode.directives.find(
    directive => directive.name === 'module',
  );
  if (moduleDirective == null) {
    return transformedNode;
  }
  if (spread.args.length !== 0) {
    throw createUserError(
      '@module does not support @arguments.',
      [spread.args[0]?.loc].filter(Boolean),
    );
  }

  const context: CompilerContext = this.getContext();
  const schema = context.getSchema();

  const jsModuleType = schema.asScalarFieldType(
    schema.getTypeFromString(JS_FIELD_TYPE),
  );
  if (jsModuleType == null || !schema.isServerType(jsModuleType)) {
    throw new createUserError(
      `'${JS_FIELD_NAME}' should be defined on the server schema.`,
      [spread.loc],
    );
  }

  if (!schema.isScalar(jsModuleType)) {
    throw createUserError(
      'Using @module requires the schema to define a scalar ' +
        `'${JS_FIELD_TYPE}' type.`,
    );
  }

  const fragment = context.getFragment(spread.name, spread.loc);
  if (!schema.isObject(fragment.type)) {
    throw createUserError(
      `@module used on invalid fragment spread '...${spread.name}'. @module ` +
        'may only be used with fragments on a concrete (object) type, ' +
        `but the fragment has abstract type '${schema.getTypeString(
          fragment.type,
        )}'.`,
      [spread.loc, fragment.loc],
    );
  }
  const field = schema.getFieldByName(fragment.type, JS_FIELD_NAME);
  if (!field) {
    throw createUserError(
      `@module used on invalid fragment spread '...${spread.name}'. @module ` +
        `requires the fragment type '${schema.getTypeString(
          fragment.type,
        )}' to have a ` +
        `'${JS_FIELD_NAME}(${JS_FIELD_MODULE_ARG}: String! ` +
        `[${JS_FIELD_ID_ARG}: String]): ${JS_FIELD_TYPE}' field (your ` +
        "schema may choose to omit the 'id'  argument but if present it " +
        "must accept a 'String').",
      [moduleDirective.loc],
    );
  }
  const jsField = schema.getFieldConfig(field);

  const jsFieldModuleArg = jsField
    ? jsField.args.find(arg => arg.name === JS_FIELD_MODULE_ARG)
    : null;
  const jsFieldIdArg = jsField
    ? jsField.args.find(arg => arg.name === JS_FIELD_ID_ARG)
    : null;
  if (
    jsFieldModuleArg == null ||
    !schema.isString(schema.getNullableType(jsFieldModuleArg.type)) ||
    ((jsFieldIdArg != null && !schema.isString(jsFieldIdArg.type)) ||
      jsField.type !== jsModuleType)
  ) {
    throw createUserError(
      `@module used on invalid fragment spread '...${spread.name}'. @module ` +
        `requires the fragment type '${schema.getTypeString(
          fragment.type,
        )}' to have a ` +
        `'${JS_FIELD_NAME}(${JS_FIELD_MODULE_ARG}: String! ` +
        `[${JS_FIELD_ID_ARG}: String]): ${JS_FIELD_TYPE}' field (your ` +
        "schema may choose to omit the 'id'  argument but if present it " +
        "must accept a 'String').",
      [moduleDirective.loc],
    );
  }

  if (spread.directives.length !== 1) {
    throw createUserError(
      `@module used on invalid fragment spread '...${spread.name}'. @module ` +
        'may not have additional directives.',
      [spread.loc],
    );
  }
  const {name: moduleName} = getLiteralArgumentValues(moduleDirective.args);
  if (typeof moduleName !== 'string') {
    throw createUserError(
      "Expected the 'name' argument of @module to be a literal string",
      [(moduleDirective.args.find(arg => arg.name === 'name') ?? spread).loc],
    );
  }
  const moduleId = [documentName, ...path].join('.');
  const normalizationName =
    getNormalizationOperationName(spread.name) + '.graphql';
  const componentKey = getModuleComponentKey(documentName);
  const componentField: ScalarField = {
    alias: componentKey,
    args: [
      {
        kind: 'Argument',
        name: JS_FIELD_MODULE_ARG,
        type: jsFieldModuleArg.type,
        value: {
          kind: 'Literal',
          loc: moduleDirective.args[0]?.loc ?? moduleDirective.loc,
          value: moduleName,
        },
        loc: moduleDirective.loc,
      },
      jsFieldIdArg != null
        ? {
            kind: 'Argument',
            name: JS_FIELD_ID_ARG,
            type: jsFieldIdArg.type,
            value: {
              kind: 'Literal',
              loc: moduleDirective.args[0]?.loc ?? moduleDirective.loc,
              value: moduleId,
            },
            loc: moduleDirective.loc,
          }
        : null,
    ].filter(Boolean),
    directives: [],
    handles: null,
    kind: 'ScalarField',
    loc: moduleDirective.loc,
    metadata: {skipNormalizationNode: true},
    name: JS_FIELD_NAME,
    type: jsModuleType,
  };
  const operationKey = getModuleOperationKey(documentName);
  const operationField: ScalarField = {
    alias: operationKey,
    args: [
      {
        kind: 'Argument',
        name: JS_FIELD_MODULE_ARG,
        type: jsFieldModuleArg.type,
        value: {
          kind: 'Literal',
          loc: moduleDirective.loc,
          value: normalizationName,
        },
        loc: moduleDirective.loc,
      },
      jsFieldIdArg != null
        ? {
            kind: 'Argument',
            name: JS_FIELD_ID_ARG,
            type: jsFieldIdArg.type,
            value: {
              kind: 'Literal',
              loc: moduleDirective.args[0]?.loc ?? moduleDirective.loc,
              value: moduleId,
            },
            loc: moduleDirective.loc,
          }
        : null,
    ].filter(Boolean),
    directives: [],
    handles: null,
    kind: 'ScalarField',
    loc: moduleDirective.loc,
    metadata: {skipNormalizationNode: true},
    name: JS_FIELD_NAME,
    type: jsModuleType,
  };

  return {
    kind: 'InlineFragment',
    directives: [],
    loc: moduleDirective.loc,
    metadata: null,
    selections: [
      {
        kind: 'ModuleImport',
        loc: moduleDirective.loc,
        documentName,
        id: moduleId,
        module: moduleName,
        name: spread.name,
        selections: [
          {
            ...spread,
            directives: spread.directives.filter(
              directive => directive !== moduleDirective,
            ),
          },
          operationField,
          componentField,
        ],
      },
    ],
    typeCondition: fragment.type,
  };
}

module.exports = {
  SCHEMA_EXTENSION,
  transform: relayMatchTransform,
};
