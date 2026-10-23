"""Parse supplied Python text only: never import or execute repository code."""
import ast
import json
import sys


def outline(row):
    try:
        tree = ast.parse(row['text'], filename=row['path'])
    except (SyntaxError, ValueError, RecursionError) as error:
        return {'symbols': [], 'imports': [], 'status': 'parse-error', 'diagnostic': str(error)[:200]}
    symbols, imports = [], []

    def visit(node, owner=''):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            name = owner + '.' + node.name if owner else node.name
            signature = ('class ' + name) if isinstance(node, ast.ClassDef) else ('def ' + name + '(' + ast.unparse(node.args) + ')')
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.returns is not None:
                signature += ' -> ' + ast.unparse(node.returns)
            symbols.append({'name': name, 'kind': 'class' if isinstance(node, ast.ClassDef) else 'function', 'line': node.lineno, 'endLine': node.end_lineno, 'signature': signature[:300]})
            owner = name
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append({'specifier': alias.name, 'line': node.lineno, 'level': 0})
        if isinstance(node, ast.ImportFrom):
            imports.append({'specifier': node.module or '', 'names': [a.name for a in node.names], 'level': node.level, 'line': node.lineno})
        for child in ast.iter_child_nodes(node):
            visit(child, owner)
    visit(tree)
    return {'symbols': symbols, 'imports': imports, 'status': 'parsed'}


if __name__ == '__main__':
    rows = json.load(sys.stdin)
    json.dump({row['path']: outline(row) for row in rows}, sys.stdout, ensure_ascii=True)
