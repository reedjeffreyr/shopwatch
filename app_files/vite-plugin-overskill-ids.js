/**
 * Vite Plugin: OverSkill Stable JSX IDs
 *
 * Injects stable data-overskill-id attributes into JSX elements at build time.
 * This enables reliable visual editing by creating a bidirectional mapping between
 * rendered DOM elements and their source code locations.
 *
 * Inspired by Lovable.dev's approach to visual editing infrastructure.
 *
 * Architecture:
 * 1. Build Time: Parse JSX with Babel AST, inject stable IDs
 * 2. Runtime: Elements have data-overskill-id in DOM
 * 3. Edit Mode: Click element → get stable ID → backend looks up file:line
 * 4. Backend: Direct file location (no searching/guessing)
 *
 * Benefits:
 * - 100% reliable element → file mapping
 * - IDs persist across styling changes (unlike class-based IDs)
 * - Fast (direct lookup vs. text/class search)
 * - Matches Lovable's proven approach
 */

import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
import * as t from '@babel/types';
import { createHash } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join, relative } from 'path';

// Babel packages use CommonJS, need default export handling for ES modules
const traverse = traverseModule.default || traverseModule;
const generate = generateModule.default || generateModule;

export default function overskillStableIds(options = {}) {
  const {
    // Output file for component mappings (JSON)
    mappingFile = 'dist/component-mappings.json',
    // Attribute name to inject
    idAttribute = 'data-overskill-id',
    // Enable debug logging (OFF by default - was causing log spam)
    debug = false
  } = options;

  if (debug) {
    console.log('🔵 [OverSkill IDs] Plugin initializing with options:', options);
  }

  // Store all mappings (stable_id → {file, line, component})
  const componentMappings = new Map();

  const plugin = {
    name: 'overskill-stable-ids',

    // CRITICAL: Run BEFORE React SWC plugin to see raw JSX
    // Without this, React transforms JSX to createElement() before we see it
    enforce: 'pre',

    // Verify plugin is loaded by Vite
    config(config, env) {
      if (debug) {
        console.log('🔵 [OverSkill IDs] config() - mode:', env.mode, 'command:', env.command);
      }
      return null;
    },

    // Verify build starts
    buildStart() {
      if (debug) {
        console.log('🔵 [OverSkill IDs] buildStart()');
      }
    },

    // Transform JSX/TSX files to inject stable IDs
    transform(code, id) {
      // EARLY EXIT: Skip node_modules FIRST (prevents log spam)
      if (id.includes('node_modules')) {
        return null;
      }

      // Only process JSX/TSX files
      if (!/\.(jsx|tsx)$/.test(id)) {
        return null;
      }

      if (debug) {
        console.log('✅ [OverSkill IDs] Processing:', id);
      }

      try {
        // Parse code into AST
        const ast = parse(code, {
          sourceType: 'module',
          plugins: ['jsx', 'typescript']
        });

        let modified = false;
        let elementsFound = 0;

        // Traverse AST and inject IDs into JSX elements
        traverse(ast, {
          JSXElement(path) {
            elementsFound++;

            const openingElement = path.node.openingElement;

            // Skip React.Fragment - it only accepts key and children props
            // Babel parses <React.Fragment> as JSXElement with JSXMemberExpression name
            // and <Fragment> as JSXElement with JSXIdentifier name "Fragment"
            const elName = openingElement.name;
            if (
              // <Fragment>...</Fragment>
              (t.isJSXIdentifier(elName) && elName.name === 'Fragment') ||
              // <React.Fragment>...</React.Fragment>
              (t.isJSXMemberExpression(elName) &&
                t.isJSXIdentifier(elName.property) &&
                elName.property.name === 'Fragment')
            ) {
              return; // Fragment doesn't accept data attributes
            }

            // Skip elements that already have data-overskill-id
            const hasId = openingElement.attributes.some(
              attr => t.isJSXAttribute(attr) &&
                      attr.name &&
                      attr.name.name === idAttribute
            );

            if (hasId) {
              return; // Already has ID, skip
            }

            // A line can contain several JSX nodes. Include the source column
            // so siblings keep distinct identities while repeated renders of
            // the same source node still share one ID.
            const lineNumber = path.node.loc?.start.line || 0;
            const columnNumber = path.node.loc?.start.column || 0;
            const stableId = generateStableId(id, lineNumber, columnNumber);

            // Inject data-overskill-id attribute
            openingElement.attributes.push(
              t.jsxAttribute(
                t.jsxIdentifier(idAttribute),
                t.stringLiteral(stableId)
              )
            );

            // Store mapping
            const tagName = openingElement.name.type === 'JSXIdentifier'
              ? openingElement.name.name
              : 'unknown';

            componentMappings.set(stableId, {
              file: relative(process.cwd(), id),
              line: lineNumber,
              column: columnNumber,
              tag: tagName,
              stableId: stableId
            });

            modified = true;
          }
        });

        // If we modified the AST, generate new code
        if (modified) {
          const output = generate(ast, {
            retainLines: true,  // Keep original line numbers
            compact: false
          }, code);

          if (debug) {
            console.log(`✅ [OverSkill IDs] Injected ${elementsFound} IDs into ${id}`);
          }

          return {
            code: output.code,
            map: output.map
          };
        }

        return null;
      } catch (error) {
        // Only log errors, not verbose debugging
        console.error(`❌ [OverSkill IDs] Error processing ${id}:`, error.message);
        return null;
      }
    },

    // After build completes, write mappings to JSON file
    closeBundle() {
      if (componentMappings.size === 0) {
        if (debug) {
          console.log('⚠️ [OverSkill IDs] No mappings to write');
        }
        return;
      }

      try {
        // Convert Map to plain object for JSON
        const mappingsObject = {};
        componentMappings.forEach((value, key) => {
          mappingsObject[key] = value;
        });

        // Ensure directory exists
        const dir = dirname(mappingFile);
        mkdirSync(dir, { recursive: true });

        // Write mappings to file
        writeFileSync(
          mappingFile,
          JSON.stringify(mappingsObject, null, 2),
          'utf-8'
        );

        // Always log successful write (useful for debugging builds)
        console.log(`[OverSkill IDs] ✅ Wrote ${componentMappings.size} component mappings to ${mappingFile}`);
      } catch (error) {
        console.error('[OverSkill IDs] ❌ Failed to write mappings:', error.message);
      }
    }
  };

  return plugin;
}

/**
 * Generate stable ID for a JSX element
 * Format: ovs-{file_hash}-{line}-{column}
 *
 * Examples:
 * - ovs-a3f2b9-42-4 (Index.tsx line 42, column 4)
 * - ovs-7c8e1d-108-12 (Hero.tsx line 108, column 12)
 *
 * The file hash ensures IDs are unique across files even if line numbers match.
 * Source positions distinguish separate nodes on the same line.
 */
function generateStableId(filePath, lineNumber, columnNumber) {
  // Create short hash of file path (first 6 chars)
  const fileHash = createHash('md5')
    .update(filePath)
    .digest('hex')
    .substring(0, 6);

  // Format: ovs-{hash}-{line}-{column}
  return `ovs-${fileHash}-${lineNumber}-${columnNumber}`;
}
