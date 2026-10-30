#!/usr/bin/env node

/**
 * Pre-build validation and auto-fix script
 * Prevents common build failures from AI-generated code
 */

import fs from 'fs';
import path from 'path';
import { HEAVY_LAZY_LIBS, findHeavyStaticImports } from './heavy-lazy-libs.js';

// Built-in glob replacement — no external dependency needed
function findFilesSync(dir, extensions) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFilesSync(fullPath, extensions));
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}
async function glob(pattern) {
  if (pattern.includes('.css')) return findFilesSync('src', ['.css']);
  if (pattern.includes('.ts')) return findFilesSync('src', ['.ts', '.tsx']);
  return [];
}

// ANSI color codes for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

let hasErrors = false;
let fixedCount = 0;

// 1. Fix invalid Tailwind classes in CSS files
async function fixTailwindClasses() {
  console.log(`${colors.blue}🔍 Checking CSS files for invalid Tailwind classes...${colors.reset}`);
  
  const cssFiles = await glob('src/**/*.css');
  
  // Map of invalid classes to valid replacements
  const classReplacements = {
    'shadow-3xl': 'shadow-2xl',
    'shadow-4xl': 'shadow-2xl',
    'shadow-5xl': 'shadow-2xl',
    'text-9xl': 'text-8xl',
    'text-10xl': 'text-8xl',
    'rounded-5xl': 'rounded-3xl',
    'rounded-6xl': 'rounded-3xl',
    'p-20': 'p-16',
    'p-24': 'p-16',
    'm-20': 'm-16',
    'm-24': 'm-16'
  };
  
  for (const file of cssFiles) {
    let content = fs.readFileSync(file, 'utf-8');
    let modified = false;
    
    for (const [invalid, valid] of Object.entries(classReplacements)) {
      const regex = new RegExp(`\\b${invalid}\\b`, 'g');
      if (regex.test(content)) {
        console.log(`${colors.yellow}  ⚠️  Found invalid class '${invalid}' in ${file}${colors.reset}`);
        content = content.replace(regex, valid);
        modified = true;
        fixedCount++;
      }
    }
    
    if (modified) {
      fs.writeFileSync(file, content);
      console.log(`${colors.green}  ✅ Fixed invalid classes in ${file}${colors.reset}`);
    }
  }
}

// 2. Validate CSS syntax and auto-fix common issues
async function validateCSSFiles() {
  console.log(`${colors.blue}🔍 Validating CSS files for syntax errors...${colors.reset}`);

  const cssFiles = await glob('src/**/*.css');
  let cssValid = true;

  for (const file of cssFiles) {
    let content = fs.readFileSync(file, 'utf8');
    let modified = false;

    // NEW: Check for invalid CSS syntax patterns
    // Pattern 1: Comma followed by semicolon (,;) - invalid CSS
    // The comma indicates continuation but ; ends the property - keep comma to continue
    if (content.includes(',;')) {
      console.log(`${colors.yellow}  ⚠️  Found invalid CSS ',;' pattern in ${file}${colors.reset}`);
      content = content.replace(/,;/g, ',');  // Keep comma, remove premature semicolon
      modified = true;
      fixedCount++;
      console.log(`${colors.green}  ✅ Fixed ',;' → ',' in ${file}${colors.reset}`);
    }

    // Pattern 2: Double semicolons (;;) - often harmless but messy
    if (/;;/.test(content)) {
      content = content.replace(/;;+/g, ';');
      modified = true;
      fixedCount++;
      console.log(`${colors.green}  ✅ Fixed double semicolons in ${file}${colors.reset}`);
    }

    // Pattern 3: Colon-semicolon (:;) - AI puts semicolon right after colon, orphaning the value
    // Example: "text-shadow:;\n  0 0 10px red;" should be "text-shadow: 0 0 10px red;"
    // This pattern captures: property-name:; followed by whitespace and the actual value
    const colonSemicolonPattern = /([a-z-]+):\s*;\s*\n\s+([^;{}]+;)/gi;
    if (colonSemicolonPattern.test(content)) {
      console.log(`${colors.yellow}  ⚠️  Found ':;' pattern (orphaned value) in ${file}${colors.reset}`);
      content = content.replace(/([a-z-]+):\s*;\s*\n\s+([^;{}]+;)/gi, '$1: $2');
      modified = true;
      fixedCount++;
      console.log(`${colors.green}  ✅ Fixed ':;' → joined property with value in ${file}${colors.reset}`);
    }

    // Pattern 4: Simple colon-semicolon without multiline (property:;) - just remove the semicolon
    // This leaves the property incomplete but prevents PostCSS crash
    if (/[a-z-]+:\s*;/i.test(content) && !/[a-z-]+:\s*;\s*\n\s+[^;{}]+;/i.test(content)) {
      console.log(`${colors.yellow}  ⚠️  Found empty property value ':;' in ${file}${colors.reset}`);
      // For simple :; patterns, we can't auto-fix without knowing the intended value
      // Just warn - this will still cause build issues but won't crash PostCSS as badly
    }

    // Pattern 5: Missing semicolon before closing brace (property: value})
    const missingSelon = /:\s*[^;{}]+\}/g;
    if (missingSelon.test(content)) {
      // Only warn - auto-fixing this is risky
      console.log(`${colors.yellow}  ⚠️  Possible missing semicolon before } in ${file}${colors.reset}`);
    }

    // Write changes if modified
    if (modified) {
      fs.writeFileSync(file, content);
    }

    // Check for brace matching
    const openBraces = (content.match(/{/g) || []).length;
    const closeBraces = (content.match(/}/g) || []).length;

    if (openBraces !== closeBraces) {
      console.log(`${colors.red}  ❌ CSS brace mismatch in ${file}: ${openBraces} open, ${closeBraces} close${colors.reset}`);

      // Try to fix by removing extra closing braces at the end
      if (closeBraces > openBraces) {
        const lines = content.split('\n');
        let removed = 0;

        // Work backwards from the end
        for (let i = lines.length - 1; i >= 0 && (closeBraces - removed) > openBraces; i--) {
          if (lines[i].trim() === '}') {
            lines.splice(i, 1);
            removed++;
          }
        }

        if (removed > 0) {
          fs.writeFileSync(file, lines.join('\n'));
          console.log(`${colors.green}  ✅ Auto-fixed ${removed} extra closing brace(s) in ${file}${colors.reset}`);
          fixedCount += removed;
        } else {
          cssValid = false;
          hasErrors = true;
        }
      } else {
        cssValid = false;
        hasErrors = true;
      }
    }
  }

  return cssValid;
}

// 3. Validate JSX/TSX syntax using TypeScript compiler
async function validateJSXSyntax() {
  console.log(`${colors.blue}🔍 Validating JSX/TSX syntax using TypeScript compiler...${colors.reset}`);
  
  try {
    // Use TypeScript compiler to check for syntax and type errors
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    // Run TypeScript compiler in check mode (no emit)
    const { stdout, stderr } = await execAsync('npx tsc --noEmit --skipLibCheck');
    
    // If there's stderr output, it means there are compilation errors
    if (stderr) {
      console.log(`${colors.yellow}  ⚠️  TypeScript compilation warnings:${colors.reset}`);
      console.log(stderr);
      // Don't set hasErrors = true for TypeScript issues that might be auto-fixed later
      // We'll re-run this check after auto-fixes
    } else {
      console.log(`${colors.green}  ✅ JSX/TSX syntax validation passed${colors.reset}`);
    }
  } catch (error) {
    // tsc returns non-zero exit code when there are errors
    if (error.stdout || error.stderr) {
      const errorText = error.stdout || error.stderr || '';
      
      // Check if these are auto-fixable errors
      const autoFixableErrors = [
        'refers to a UMD global',  // Missing React import
        'Cannot find module',       // Missing imports
        'is not defined'           // Missing declarations
      ];
      
      const isAutoFixable = autoFixableErrors.some(err => errorText.includes(err));
      
      if (isAutoFixable) {
        console.log(`${colors.yellow}  ⚠️  TypeScript errors detected (will attempt auto-fix):${colors.reset}`);
        if (error.stdout) console.log(error.stdout);
        if (error.stderr) console.log(error.stderr);
        // Don't fail yet - we'll try to fix these
      } else {
        console.log(`${colors.red}  ❌ Critical TypeScript compilation errors:${colors.reset}`);
        if (error.stdout) console.log(error.stdout);
        if (error.stderr) console.log(error.stderr);
        hasErrors = true;
      }
    } else {
      console.log(`${colors.red}  ❌ Failed to run TypeScript compiler: ${error.message}${colors.reset}`);
      hasErrors = true;
    }
  }
}

// 3. Run ESLint for code quality checks
async function runESLintValidation() {
  console.log(`${colors.blue}🔍 Running ESLint validation...${colors.reset}`);
  
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    // Run ESLint on src directory
    const { stdout, stderr } = await execAsync('npx eslint src/ --ext .js,.jsx,.ts,.tsx --format compact');
    
    if (stdout.trim()) {
      console.log(`${colors.yellow}  ⚠️  ESLint issues found:${colors.reset}`);
      console.log(stdout);
      // ESLint issues are warnings, not build blockers
    } else {
      console.log(`${colors.green}  ✅ ESLint validation passed${colors.reset}`);
    }
  } catch (error) {
    // ESLint returns non-zero exit code when there are errors
    if (error.stdout) {
      console.log(`${colors.yellow}  ⚠️  ESLint issues found:${colors.reset}`);
      console.log(error.stdout);
      // Don't fail build for ESLint issues, they're usually style/quality issues
    } else if (error.stderr) {
      console.log(`${colors.yellow}  ⚠️  ESLint warning: ${error.stderr}${colors.reset}`);
    }
  }
}

// 4. Auto-fix missing React imports
async function fixMissingReactImports() {
  console.log(`${colors.blue}🔍 Checking for missing React imports...${colors.reset}`);
  
  const tsxFiles = await glob('src/**/*.{ts,tsx}');
  
  for (const file of tsxFiles) {
    let content = fs.readFileSync(file, 'utf-8');
    let modified = false;
    
    // Check if file uses JSX syntax (contains < followed by capital letter)
    const hasJSX = /<[A-Z]/.test(content);
    
    // Check if file uses React hooks
    const usesHooks = /\b(useState|useEffect|useCallback|useMemo|useRef|useContext|useReducer)\b/.test(content);
    
    // Check if file uses React.* references
    const usesReactNamespace = /\bReact\.\w+/.test(content);
    
    // Check if React is already imported
    const hasReactImport = /import\s+(?:\*\s+as\s+)?React(?:\s*,\s*{[^}]*})?(?:\s+from\s+['"]react['"])/m.test(content);
    
    if ((hasJSX || usesReactNamespace) && !hasReactImport) {
      // Add React import at the beginning of the file
      const importStatement = "import React from 'react';";
      
      // Find the first import statement or the beginning of the file
      const firstImportMatch = content.match(/^import\s+.*$/m);
      if (firstImportMatch) {
        // Add before the first import
        const firstImportIndex = content.indexOf(firstImportMatch[0]);
        content = content.substring(0, firstImportIndex) + importStatement + '\n' + content.substring(firstImportIndex);
      } else {
        // No imports, add at the beginning
        content = importStatement + '\n\n' + content;
      }
      
      fs.writeFileSync(file, content);
      console.log(`${colors.green}  ✅ Added missing React import to ${file}${colors.reset}`);
      fixedCount++;
      modified = true;
    }
  }
}

// 5. Validate TypeScript imports and auto-fix missing page/component imports
async function validateImports() {
  console.log(`${colors.blue}🔍 Checking for missing component imports...${colors.reset}`);
  
  const tsxFiles = await glob('src/**/*.{ts,tsx}');
  
  for (const file of tsxFiles) {
    let content = fs.readFileSync(file, 'utf-8');
    let modified = false;
    
    // Check for usage of components/pages in JSX and Routes
    // Pattern to find JSX components and Route elements
    const jsxUsageRegex = /<([A-Z][A-Za-z]*)\s*[^>]*\/?>|element=\{<([A-Z][A-Za-z]*)\s*[^>]*\/?>}/g;
    const usedComponents = new Set();
    
    let match;
    while ((match = jsxUsageRegex.exec(content)) !== null) {
      const componentName = match[1] || match[2];
      if (componentName && !componentName.includes('.')) {
        usedComponents.add(componentName);
      }
    }
    
    // Check which components are not imported
    const missingImports = [];
    for (const component of usedComponents) {
      // Skip HTML elements and already imported components
      const htmlElements = ['Router', 'Routes', 'Route', 'BrowserRouter', 'Link', 'NavLink'];
      if (htmlElements.includes(component)) continue;

      // Check if component is already imported (standard import)
      const importRegex = new RegExp(`import\\s+(?:{[^}]*\\b${component}\\b[^}]*}|${component})\\s+from`, 'm');

      // Check if component is defined via lazy() import
      // Pattern: const ComponentName = lazy(() => import(...))
      const lazyImportRegex = new RegExp(`const\\s+${component}\\s*=\\s*lazy\\s*\\(`);

      // Also check if it's a local function/const definition (not just lazy)
      // Pattern: function ComponentName or const ComponentName =
      const localDefinitionRegex = new RegExp(`(?:function\\s+${component}\\s*\\(|const\\s+${component}\\s*=)`, 'm');

      if (!importRegex.test(content) && !lazyImportRegex.test(content) && !localDefinitionRegex.test(content)) {
        // Check if it's a page component
        const pagePath = `./pages/${component}`;
        const pageFile = path.join(path.dirname(file), 'pages', `${component}.tsx`);
        if (fs.existsSync(pageFile)) {
          missingImports.push(`import ${component} from "${pagePath}";`);
          console.log(`${colors.yellow}  ⚠️  Missing import for page component '${component}' in ${file}${colors.reset}`);
        }
        // Check if it's a component
        else {
          const componentPath = `./components/${component}`;
          const componentFile = path.join(path.dirname(file), 'components', `${component}.tsx`);
          if (fs.existsSync(componentFile)) {
            missingImports.push(`import ${component} from "${componentPath}";`);
            console.log(`${colors.yellow}  ⚠️  Missing import for component '${component}' in ${file}${colors.reset}`);
          }
        }
      }
    }
    
    // Common UI components that need imports
    const componentPatterns = [
      { pattern: /<(Card|CardContent|CardHeader|CardFooter|CardTitle|CardDescription)\b/, import: "import { Card, CardContent, CardHeader, CardFooter, CardTitle, CardDescription } from '@/components/ui/card'" },
      { pattern: /<(Button)\b/, import: "import { Button } from '@/components/ui/button'" },
      { pattern: /<(Input)\b/, import: "import { Input } from '@/components/ui/input'" },
      { pattern: /<(Label)\b/, import: "import { Label } from '@/components/ui/label'" },
      { pattern: /<(Select|SelectContent|SelectItem|SelectTrigger|SelectValue)\b/, import: "import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'" }
    ];
    
    for (const { pattern, import: importStatement } of componentPatterns) {
      const importPath = importStatement.split(' from ')[1];
      const existingImportRegex = new RegExp(`import\\s*{[^}]*}\\s*from\\s*${importPath.replace(/['"]/g, '[\'"]')}`);
      
      if (pattern.test(content) && !existingImportRegex.test(content)) {
        missingImports.push(importStatement);
      }
    }
    
    if (missingImports.length > 0) {
      // Find the last import statement to add new imports after it
      const importMatches = content.match(/^import\s+.*$/gm);
      if (importMatches && importMatches.length > 0) {
        const lastImport = importMatches[importMatches.length - 1];
        const lastImportIndex = content.lastIndexOf(lastImport);
        const beforeImports = content.substring(0, lastImportIndex + lastImport.length);
        const afterImports = content.substring(lastImportIndex + lastImport.length);
        
        content = beforeImports + '\n' + missingImports.join('\n') + afterImports;
      } else {
        // No existing imports, add at the beginning
        content = missingImports.join('\n') + '\n\n' + content;
      }
      
      fs.writeFileSync(file, content);
      console.log(`${colors.green}  ✅ Auto-fixed ${missingImports.length} missing imports in ${file}${colors.reset}`);
      fixedCount += missingImports.length;
      modified = true;
    }
  }
}

// 6. Validate and fix SDK import issues (overskill-sdk)
async function validateSDKImports() {
  console.log(`${colors.blue}🔍 Validating overskill-sdk imports...${colors.reset}`);

  const tsxFiles = await glob('src/**/*.{ts,tsx}');

  // Invalid import patterns that AI sometimes hallucinates
  const invalidImports = [
    // Pattern 1: Scoped package name (doesn't exist)
    {
      pattern: /import\s+\{[^}]*\}\s+from\s+['"]@overskill\/sdk['"]/g,
      message: 'Wrong package: @overskill/sdk (scoped) should be overskill-sdk (unscoped)',
      fix: (content) => content.replace(
        /import\s+(\{[^}]*\})\s+from\s+['"]@overskill\/sdk['"]/g,
        "import $1 from 'overskill-sdk'"
      )
    },
    // Pattern 2: Importing 'entities' directly (not exported)
    {
      pattern: /import\s+\{\s*entities\s*[^}]*\}\s+from\s+['"]overskill-sdk['"]/g,
      message: "'entities' is not exported from overskill-sdk - use overskill.entities instead",
      fix: (content) => content.replace(
        /import\s+\{\s*entities\s*,?\s*([^}]*)\}\s+from\s+['"]overskill-sdk['"]/g,
        (match, rest) => {
          const remaining = rest.trim().replace(/^,|,$/g, '').trim();
          if (remaining) {
            return `import { overskill, ${remaining} } from 'overskill-sdk'`;
          }
          return "import { overskill } from 'overskill-sdk'";
        }
      )
    },
    // Pattern 3: Importing 'client' directly (not exported)
    {
      pattern: /import\s+\{\s*client\s*[^}]*\}\s+from\s+['"]overskill-sdk['"]/g,
      message: "'client' is not exported from overskill-sdk - use overskill or createClient instead",
      fix: (content) => content.replace(
        /import\s+\{\s*client\s*,?\s*([^}]*)\}\s+from\s+['"]overskill-sdk['"]/g,
        (match, rest) => {
          const remaining = rest.trim().replace(/^,|,$/g, '').trim();
          if (remaining) {
            return `import { overskill, ${remaining} } from 'overskill-sdk'`;
          }
          return "import { overskill } from 'overskill-sdk'";
        }
      )
    },
    // Pattern 4: Default import style (wrong)
    {
      pattern: /import\s+overskillSDK\s+from\s+['"]overskill-sdk['"]/g,
      message: 'Wrong import style: use { overskill } or { createClient } instead of default import',
      fix: (content) => content.replace(
        /import\s+overskillSDK\s+from\s+['"]overskill-sdk['"]/g,
        "import { overskill } from 'overskill-sdk'"
      ).replace(/overskillSDK\./g, 'overskill.')
    },
    // Pattern 5: Namespace import (wrong)
    {
      pattern: /import\s+\*\s+as\s+SDK\s+from\s+['"]overskill-sdk['"]/g,
      message: 'Wrong import style: use { overskill } instead of namespace import',
      fix: (content) => content.replace(
        /import\s+\*\s+as\s+SDK\s+from\s+['"]overskill-sdk['"]/g,
        "import { overskill } from 'overskill-sdk'"
      ).replace(/SDK\./g, 'overskill.')
    },
    // Pattern 6: Importing useEntity / useEntities — neither exists in the SDK (Apr 2026).
    // The canonical pattern is `useState` + `useEffect` + `overskill.entities.X.list()`.
    // Strip the bad named import; the developer / AI's next pass will replace
    // the call sites with the imperative pattern. See investigation:
    // docs/ultrathink/ai-entity-hallucination-investigation-apr-2026/FINDINGS.md
    {
      pattern: /import\s+\{[^}]*\b(useEntity|useEntities)\b[^}]*\}\s+from\s+['"]overskill-sdk['"]/g,
      message: 'useEntity / useEntities are NOT exported by overskill-sdk — use overskill.entities.X.list() with useState + useEffect instead',
      fix: (content) => content.replace(
        /import\s+\{([^}]*)\}\s+from\s+['"]overskill-sdk['"]/g,
        (match, imports) => {
          // Drop useEntity and useEntities from the import list, preserve everything else.
          const remaining = imports
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s && !/^useEntit(?:y|ies)(?:\s+as\s+\w+)?$/.test(s));
          if (remaining.length === 0) {
            return ''; // entire import line was just useEntity/useEntities
          }
          return `import { ${remaining.join(', ')} } from 'overskill-sdk'`;
        }
      )
    }
  ];

  for (const file of tsxFiles) {
    let content = fs.readFileSync(file, 'utf-8');
    let modified = false;

    for (const { pattern, message, fix } of invalidImports) {
      if (pattern.test(content)) {
        console.log(`${colors.yellow}  ⚠️  ${message} in ${file}${colors.reset}`);
        content = fix(content);
        modified = true;
        fixedCount++;
        console.log(`${colors.green}  ✅ Auto-fixed SDK import in ${file}${colors.reset}`);
        // Reset lastIndex for global regex
        pattern.lastIndex = 0;
      }
    }

    // Also check for direct use of 'entities.' without proper import
    const hasEntitiesDirect = /\bentities\.[a-zA-Z]+\.(list|create|update|delete|get|filter|bulkCreate)\b/.test(content);
    const hasOveskillImport = /import\s+\{[^}]*overskill[^}]*\}\s+from/.test(content);

    if (hasEntitiesDirect && !hasOveskillImport) {
      console.log(`${colors.yellow}  ⚠️  Using 'entities.' directly without 'overskill' import in ${file}${colors.reset}`);
      console.log(`${colors.yellow}      Should be: overskill.entities.entityName.method()${colors.reset}`);
      // This is harder to auto-fix without context, just warn
    }

    if (modified) {
      fs.writeFileSync(file, content);
    }
  }
}

// 7. Fix common non-breaking TypeScript patterns (warnings only)
async function fixTypeScriptErrors() {
  console.log(`${colors.blue}🔍 Checking common TypeScript patterns...${colors.reset}`);
  
  const tsxFiles = await glob('src/**/*.{ts,tsx}');
  
  for (const file of tsxFiles) {
    let content = fs.readFileSync(file, 'utf-8');
    let modified = false;
    
    // Fix incorrect useState syntax (this is fixable)
    const incorrectUseState = /const\s+(\w+)\s*=\s*useState\(/g;
    if (incorrectUseState.test(content)) {
      content = content.replace(incorrectUseState, 'const [$1, set$1] = useState(');
      modified = true;
      fixedCount++;
      console.log(`${colors.green}  ✅ Fixed useState syntax in ${file}${colors.reset}`);
    }
    
    // Check for missing return statements (warning only - too complex to auto-fix)
    if (content.includes('export default function') || content.includes('export function')) {
      const functionRegex = /export\s+(default\s+)?function\s+\w+\([^)]*\)\s*{([^}]*)}/g;
      let match;
      while ((match = functionRegex.exec(content)) !== null) {
        const body = match[2];
        if (!body.includes('return') && body.trim().length > 10) {
          console.log(`${colors.yellow}  ⚠️  Function may be missing return statement in ${file} (not breaking build)${colors.reset}`);
        }
      }
    }
    
    if (modified) {
      fs.writeFileSync(file, content);
    }
  }
}

// Re-validate after fixes to check if all issues are resolved
async function finalValidation() {
  console.log(`${colors.blue}🔍 Running final validation after auto-fixes...${colors.reset}`);
  
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    // Run TypeScript compiler one more time after all fixes
    const { stdout, stderr } = await execAsync('npx tsc --noEmit --skipLibCheck');
    
    if (stderr) {
      console.log(`${colors.green}  ✅ TypeScript validation completed with warnings (non-blocking)${colors.reset}`);
      return false; // Warnings, not errors
    } else {
      console.log(`${colors.green}  ✅ TypeScript validation passed - all issues resolved!${colors.reset}`);
      return true;
    }
  } catch (error) {
    // Check if these are truly critical errors that can't be ignored
    const errorText = error.stdout || error.stderr || '';
    
    // Only fail on truly critical, unfixable errors
    const criticalErrors = [
      'Syntax error',
      'Cannot write file',
      'Out of memory',
      'FATAL ERROR'
    ];
    
    const isCritical = criticalErrors.some(err => errorText.includes(err));
    
    if (isCritical) {
      console.log(`${colors.red}  ❌ Critical TypeScript errors that cannot be auto-fixed:${colors.reset}`);
      if (error.stdout) console.log(error.stdout);
      if (error.stderr) console.log(error.stderr);
      return false;
    } else {
      console.log(`${colors.yellow}  ⚠️  TypeScript completed with warnings (non-blocking):${colors.reset}`);
      if (error.stdout) console.log(error.stdout.substring(0, 500)); // Limit output
      return true; // Allow build to continue
    }
  }
}

// 8. Bundle-size self-correction (issue #2383) — detect heavy "lazy-only"
//    libraries (recharts, pdfjs-dist, xlsx, …) statically imported from an
//    EAGERLY-loaded module, which forces them into the eager Cloudflare Worker
//    bundle and (as the app grows) blows the 6MB asset limit → cryptic deploy
//    failure + credit-burning publish loop.
//
//    This is the headline self-heal: instead of letting the AI ship code that
//    fails at deploy time, we FAIL the build here with a structured, actionable
//    correction. Because `npm run build` runs `validate-and-fix` first, a
//    non-zero exit surfaces this message to the OverSkill generation pipeline's
//    build-error auto-fix loop (the same channel CSS/import errors use), which
//    feeds it back to the model so it regenerates the file with a lazy import.
const SRC_ROOT = path.resolve('src');
const RESOLVE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs'];

// Resolve an import specifier to a LOCAL source file path, or null for bare
// (node_modules) specifiers. Mirrors the vite alias `@` → ./src.
function resolveLocalImport(specifier, fromFile) {
  let base;
  if (specifier.startsWith('@/')) {
    base = path.join(SRC_ROOT, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null; // bare specifier → node_modules, not a local file
  }
  const candidates = [
    base,
    ...RESOLVE_EXTS.map((e) => base + e),
    ...RESOLVE_EXTS.map((e) => path.join(base, 'index' + e))
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* not this candidate */
    }
  }
  return null;
}

// Specifiers reached via STATIC edges (import…from, export…from, side-effect
// import). Dynamic `import("x")` and `React.lazy(() => import("x"))` are
// deliberately NOT matched — those are the lazy boundaries we WANT.
function staticImportSpecifiers(source) {
  const specs = [];
  const patterns = [
    /^\s*import\s+(?!type\b)[^'";]*?\s+from\s+["']([^"']+)["']/gm, // import x from "y"
    /^\s*export\s+[^'";]*?\s+from\s+["']([^"']+)["']/gm, // export … from "y"
    /^\s*import\s+["']([^"']+)["']/gm // import "y" (side-effect)
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

// Walk the static-import graph from the app entry and report any heavy-lib
// imports reachable WITHOUT crossing a dynamic-import boundary.
function detectEagerHeavyImports() {
  const entry = ['main.tsx', 'main.ts', 'index.tsx', 'index.ts', 'App.tsx']
    .map((f) => path.join(SRC_ROOT, f))
    .find((p) => fs.existsSync(p));
  if (!entry) return [];

  const visited = new Set();
  const stack = [entry];
  const violations = [];
  // De-dupe by file+lib so we don't double-report the same import.
  const seenViolation = new Set();

  while (stack.length) {
    const file = stack.pop();
    if (visited.has(file)) continue;
    visited.add(file);

    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const hit of findHeavyStaticImports(source)) {
      const rel = path.relative(process.cwd(), file);
      const dedupeKey = `${rel}::${hit.key}`;
      if (!seenViolation.has(dedupeKey)) {
        seenViolation.add(dedupeKey);
        violations.push({ file: rel, ...hit });
      }
    }

    for (const spec of staticImportSpecifiers(source)) {
      const resolved = resolveLocalImport(spec, file);
      if (resolved && !visited.has(resolved)) stack.push(resolved);
    }
  }

  return violations;
}

// Build the model-readable correction. The `EAGER_HEAVY_IMPORT` /
// `Bundle-size violation` markers are matched by Deployment::BuildErrorParser
// so the generation auto-fix loop routes this to the model as a fixable error.
function formatEagerImportCorrection(violations) {
  const lines = [];
  lines.push(
    `${colors.red}❌ Bundle-size violation (EAGER_HEAVY_IMPORT)${colors.reset}`
  );
  for (const v of violations) {
    lines.push('');
    lines.push(
      `  \`${v.specifier}\` is statically imported in ${v.file}:${v.line} — ` +
        `${v.reason}. This forces it into the EAGER Cloudflare Worker bundle ` +
        `(5.5MB Overskill budget); as the app grows this WILL exceed the budget, ` +
        `fail the build, and — left unfixed — risks Cloudflare's hard 1s Worker ` +
        `startup limit.`
    );
    lines.push(`  FIX: ${v.fix}`);
  }
  lines.push('');
  lines.push(
    '  RULE: never import recharts (or "@/components/ui/chart") or a heavy ' +
      'parser library at the top level of an eagerly-loaded route/component. ' +
      'Move the usage into its own file and load it with ' +
      'React.lazy(() => import("./MyComponent")) (UI) or `await import(...)` ' +
      '(non-UI). A manualChunks name does NOT make a chunk lazy — only the ' +
      'dynamic import() boundary does.'
  );
  return lines.join('\n');
}

// Main execution
async function main() {
  console.log(`${colors.blue}🚀 Starting pre-build validation and auto-fix...${colors.reset}\n`);
  
  try {
    // Phase 1: Run initial validation to detect issues
    console.log(`${colors.blue}📋 Phase 1: Initial validation${colors.reset}`);
    await validateCSSFiles();           // Check for CSS syntax errors (NEW!)
    await validateJSXSyntax();          // Check for TypeScript errors
    await runESLintValidation();        // Check for linting issues
    
    // Phase 2: Run all auto-fixes
    console.log(`\n${colors.blue}🔧 Phase 2: Auto-fixing detected issues${colors.reset}`);
    await fixTailwindClasses();         // Fix invalid Tailwind classes
    await validateSDKImports();         // Fix SDK import errors (NEW - @overskill/sdk, entities, etc)
    await fixMissingReactImports();     // Fix missing React imports
    await validateImports();            // Fix missing component imports
    await fixTypeScriptErrors();        // Fix common TypeScript patterns
    
    // Phase 3: Final validation after fixes
    console.log(`\n${colors.blue}✅ Phase 3: Final validation${colors.reset}`);
    const finalResult = await finalValidation();

    // Phase 3.5: Bundle-size self-correction (issue #2383).
    // This CANNOT be auto-fixed here (it requires restructuring to a lazy
    // import boundary) — so we fail with a corrective message the generation
    // loop feeds back to the model. Runs after auto-fixes so any import
    // rewrites above are reflected. Heavy-lib imports inside dynamically-loaded
    // modules are intentionally NOT flagged (those are already lazy/correct).
    console.log(`\n${colors.blue}📦 Checking for heavy libraries in the eager bundle...${colors.reset}`);
    const eagerHeavyViolations = detectEagerHeavyImports();
    if (eagerHeavyViolations.length > 0) {
      console.error('\n' + formatEagerImportCorrection(eagerHeavyViolations) + '\n');
      process.exit(1);
    }
    console.log(`  ${colors.green}✅ No heavy libraries statically imported from eager routes${colors.reset}`);

    console.log(`\n${colors.blue}📊 Validation Summary:${colors.reset}`);
    console.log(`  ${colors.green}✅ Fixed ${fixedCount} issues automatically${colors.reset}`);
    
    if (hasErrors && !finalResult) {
      console.log(`  ${colors.red}❌ Found critical build-breaking errors that could not be fixed${colors.reset}`);
      console.log(`  ${colors.red}These must be manually fixed before deployment can continue${colors.reset}`);
      console.log(`\n${colors.red}⚠️  Build stopped due to unfixable critical issues${colors.reset}`);
      process.exit(1);
    } else {
      console.log(`  ${colors.green}✅ All critical checks passed!${colors.reset}`);
      console.log(`  ${colors.blue}Build can proceed. Any remaining warnings are non-blocking.${colors.reset}`);
    }
  } catch (error) {
    console.error(`${colors.red}❌ Validation script failed: ${error.message}${colors.reset}`);
    process.exit(1);
  }
}

main();