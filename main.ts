import { App, Plugin, PluginSettingTab, Setting, TFile, debounce } from 'obsidian';
import {
	Decoration, DecorationSet, EditorView,
	ViewPlugin, ViewUpdate, WidgetType, PluginValue
} from "@codemirror/view";
import { RangeSetBuilder, Extension } from "@codemirror/state";

const DEBOUNCE_TIME = 400; //ms

/**
 * Settings interface for the plugin.
 */
interface PluginSettings {
	prefix: string;
}

/** Default plugin settings. */
const DEFAULT_SETTINGS: PluginSettings = {
	prefix: 'Equation '
};

/**
 * Main plugin class.
 */
export default class ReferencesPlugin extends Plugin {
	settings: PluginSettings;

	/**
	 * Called once when the plugin is loaded/enabled.
	 */
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new RefereenceSettingTab(this.app, this));

		// Register CodeMirror extension (adds Live Preview decorations + auto tag updater)
		this.registerEditorExtension(this.referenceWidgetExtension());

		this.registerMarkdownPostProcessor(async (el, ctx) => {
			const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
			if (!file || !(file instanceof TFile)) return;

			const content = await this.app.vault.cachedRead(file);

			// Now you have the raw Markdown text for the note being rendered
			// => you can scan it for %\label{...}
			const labels = new Map<string, number>();
			const labelRegex = /%\s*\\label\{(.+?)\}/g;
			let count = 0, m: RegExpExecArray | null;

			while ((m = labelRegex.exec(content))) {
				count++;
				labels.set(m[1], count);
			}

			// Then replace \ref{...} in the rendered HTML
			const prefix = this.settings.prefix ?? "Equation ";
			const refRegex = /\\ref\{([^}]+)\}/g;

			el.querySelectorAll("p, li, div, span").forEach(node => {
				node.childNodes.forEach(child => {
					if (child.nodeType === Node.TEXT_NODE) {
						const text = child.textContent ?? "";
						const replaced = text.replace(refRegex, (full, key) => {
							const num = labels.get(key);
							return num ? `${prefix}${num}` : full;
						});
						if (replaced !== text) {
							child.textContent = replaced;
						}
					}
				});
			});
		});

	}

	/**
	 * Called when the plugin is disabled/unloaded.
	 */
	onunload() { }

	/**
	 * Create the CodeMirror extension that overlays \ref{...}
	 * with a widget ("Prefix N") in Live Preview and keeps \tag{} updated.
	 */
	private referenceWidgetExtension(): Extension {
		const getPrefix = () => this.settings.prefix;

		return ViewPlugin.define(
			(view: EditorView) => new ReferenceDisplayClass(view, getPrefix),
			{ decorations: v => v.decorations }
		);
	}

	/**
	 * Load settings from disk.
	 */
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	/**
	 * Save settings to disk.
	 */
	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/**
 * Simple type to hold label metadata.
 */
type Label = {
	label: string;
	lineNumber: number;
	numeration: number;
};

/**
 * Settings tab UI.
 */
class RefereenceSettingTab extends PluginSettingTab {
	plugin: ReferencesPlugin;

	constructor(app: App, plugin: ReferencesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Prefix')
			.setDesc('The prefix used for references')
			.addText(text => text
				.setPlaceholder('Prefix')
				.setValue(this.plugin.settings.prefix)
				.onChange(async (value) => {
					this.plugin.settings.prefix = value;
					await this.plugin.saveSettings();
				}));
	}
}

/**
 * Widget for replacing a raw \ref{...} in Live Preview
 * with "Prefix N".
 */
class RefWidget extends WidgetType {
	constructor(private lbl: Label, private prefix: string) { super(); }

	toDOM() {
		const span = document.createElement("span");
		span.className = "equation-ref";
		span.textContent = `${this.prefix}${this.lbl.numeration}`;
		return span;
	}
}

/**
 * View plugin that scans the editor:
 *  - builds decorations to replace \ref{...} with RefWidget
 *  - keeps \tag{N} synced with labels, with a 500ms debounce
 */
class ReferenceDisplayClass implements PluginValue {
	decorations: DecorationSet;
	private cachedLabels = new Map<string, Label>();

	constructor(
		private view: EditorView,
		private getPrefix: () => string
	) {
		this.decorations = this.buildDecorations(view);
		this.scheduleTagUpdate();
	}

	update(update: ViewUpdate) {
		if (
			update.docChanged ||
			update.viewportChanged ||
			update.selectionSet ||
			update.focusChanged
		) {
			this.decorations = this.buildDecorations(update.view);
		}
		if (update.docChanged) {
			this.scheduleTagUpdate();
		}
	}

	/**
	 * Debounced tag updater – waits 2000ms after typing stops.
	 */
	readonly scheduleTagUpdate = debounce(() => {
		this.cachedLabels = this.updateTags(this.view); // cache labels here
		this.decorations = this.buildDecorations(this.view);
		this.view.dispatch({ effects: [] });
	}, DEBOUNCE_TIME, true);


	/**
	 * Ensure every %\label{key} line has a correct \tag{N}.
	 * Returns the labels map (so buildDecorations can reuse it).
	 */
	private updateTags(view: EditorView): Map<string, Label> {
		const state = view.state;
		const doc = state.doc;

		const labels = new Map<string, Label>();
		const changes: { from: number; to?: number; insert: string }[] = [];

		const labelRegex = /\\label\{(.+?)\}/;
		const tagRegex = /\\tag\{.*?\}/;

		let count = 0;

		for (let i = 1; i <= doc.lines; i++) {
			const lineInfo = doc.line(i);
			const line = lineInfo.text;

			const match = line.match(labelRegex);
			if (!match) continue;

			count++;
			const key = match[1];
			const numeration = count;
			labels.set(key, {
				label: key,
				lineNumber: i - 1,
				numeration
			});

			const newTag = `\\tag{${numeration}}`;

			// If there is already a tag, replace only that substring (minimal change)
			const tagMatch = line.match(tagRegex);
			if (tagMatch) {
				if (tagMatch[0] !== newTag) {
					const from = lineInfo.from + (tagMatch.index ?? 0);
					const to = from + tagMatch[0].length;
					changes.push({ from, to, insert: newTag });
				}
				continue;
			}

			// Otherwise only add tags if label is in a comment
			const comIdx = line.indexOf("%");
			if (comIdx === -1) continue;

			const dblIdx = line.indexOf("\\\\");
			const insertIdx =
				dblIdx !== -1 && dblIdx < comIdx
					? dblIdx
					: comIdx;

			const insertPos = lineInfo.from + insertIdx;
			changes.push({ from: insertPos, insert: `${newTag} ` });
		}

		if (changes.length > 0) {
			// Single transaction: CodeMirror will map the current selection through the changes
			view.dispatch({ changes });
		}

		return labels;
	}


	/**
	 * Build decorations for \ref{...} using cached labels.
	 */
	private buildDecorations(view: EditorView): DecorationSet {
		const labels = this.cachedLabels; // reuse cached labels instead of rescanning

		const builder = new RangeSetBuilder<Decoration>();
		const refRegex = /\\ref\{([^}]+)\}/g;
		const sel = view.state.selection;

		for (const { from, to } of view.visibleRanges) {
			const text = view.state.doc.sliceString(from, to);
			let m: RegExpExecArray | null;
			while ((m = refRegex.exec(text))) {
				const [full, key] = m;
				const lbl = labels.get(key);
				if (!lbl) continue;

				const start = from + m.index;
				const end = start + full.length;

				// If the cursor is inside -> show raw text instead of widget
				let overlapsCursor = false;
				for (const range of sel.ranges) {
					if (!(range.to <= start || range.from >= end)) {
						overlapsCursor = true;
						break;
					}
				}
				if (overlapsCursor) continue;

				builder.add(
					start,
					end,
					Decoration.replace({
						widget: new RefWidget(lbl, this.getPrefix()),
						inclusive: false
					})
				);
			}
		}

		return builder.finish();
	}

	destroy() { /* no-op */ }
}
