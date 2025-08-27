# Obsidian References Plugin

An Obsidian plugin that makes Numbering LaTeX equations easier:

- Automatically numbers equations (`\tag{N}`) based on `%\label{...}` comments.
- Replaces `\ref{...}` with a prefix and the equations numbering.

---

## Features

- **Automatic numbering**  
  Every equation with a `%\label{key}` comment is assigned a sequential number, and a `\tag{N}` is inserted or updated automatically.

- **Live references**  
  In Live Preview mode, `\ref{key}` is displayed as `Equation N` (or whatever prefix you choose).  
  When your cursor enters the reference, the raw `\ref{key}` text is shown for editing.

- **Customizable prefix**  
  Configure the word shown before the number (e.g. `Equation`, `Eq.`, `Gleichung`).
