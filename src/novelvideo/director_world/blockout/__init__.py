"""Reference image → editable blockout (white-model) scene for the previz studio.

The vision model writes a SceneBlockoutDSL program. The program is parsed with an
AST whitelist and compiled deterministically. It is never executed.
"""
