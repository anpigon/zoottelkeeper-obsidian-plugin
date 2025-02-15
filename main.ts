import i18next from "i18next";
import { SortOrder } from "models";
import * as emoji from "node-emoji";
import {
  App,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  debounce,
  moment,
} from "obsidian";
import { DEFAULT_SETTINGS } from "./defaultSettings";
import {
  GeneralContentOptions,
  ZoottelkeeperPluginSettings,
} from "./interfaces";
import { IndexItemStyle } from "./interfaces/IndexItemStyle";
import * as en from "./locales/en.json";
import * as ko from "./locales/ko.json";
import {
  hasFrontmatter,
  isInAllowedFolder,
  isInDisAllowedFolder,
  removeFrontmatter,
  updateFrontmatter,
  updateIndexContent,
} from "./utils";

//detect language
console.log(moment.locale());

i18next.init({
  lng: moment.locale() || "en",
  fallbackLng: "en",
  resources: {
    en: { translation: en },
    ko: { translation: ko },
  },
});

export default class ZoottelkeeperPlugin extends Plugin {
  settings: ZoottelkeeperPluginSettings;
  lastVault: Set<string>;

  triggerUpdateIndexFile = debounce(
    (file: TAbstractFile, oldPath?: string) => {
      this.keepTheZooClean(false, file, oldPath);
    },
    3000,
    true,
  );

  async onload(): Promise<void> {
    console.info("loading zoottelkeeper plugin");
    await this.loadSettings();
    this.app.workspace.onLayoutReady(async () => {
      this.loadVault();
      console.debug(
        `Vault in files: ${JSON.stringify(
          this.app.vault.getMarkdownFiles().map((f) => f.path),
        )}`,
      );
    });
    this.registerEvent(
      this.app.vault.on("create", this.triggerUpdateIndexFile),
    );
    this.registerEvent(
      this.app.vault.on("delete", this.triggerUpdateIndexFile),
    );
    this.registerEvent(
      this.app.vault.on("rename", this.triggerUpdateIndexFile),
    );

    this.addSettingTab(new ZoottelkeeperPluginSettingTab(this.app, this));
  }

  loadVault() {
    this.lastVault = this.getVaultSet();
  }

  getVaultSet() {
    return new Set(this.app.vault.getMarkdownFiles().map((file) => file.path));
  }

  async keepTheZooClean(
    triggeredManually?: boolean,
    file?: TAbstractFile,
    oldPath?: string,
  ) {
    console.info("keeping the zoo clean...");
    if (this.lastVault || triggeredManually) {
      const vaultFilePathsSet = this.getVaultSet();
      try {
        const changedFiles = this.getCreatedAndDeletedFiles(vaultFilePathsSet);

        console.debug(`changedFiles: ${JSON.stringify(changedFiles)}`);

        const indexFileAndNewPath = this.getIndexFile2BRenamed(file, oldPath);

        const indexFiles2BUpdated = this.getIndexFiles2BUpdated(changedFiles);

        console.debug(
          `Index files to be updated: ${JSON.stringify(
            Array.from(indexFiles2BUpdated),
          )}`,
        );

        await this.renameIndexFile(indexFileAndNewPath);
        await this.updateIndexFiles(indexFiles2BUpdated);
      } catch (e) {
        console.error("Error during indexing", e);
      }
    }
    this.lastVault = this.getVaultSet();
    console.info("zoo is clean now");
  }

  getCreatedAndDeletedFiles(vaultFilePathsSet: Set<string>) {
    // getting the changed files using symmetric diff
    const createdFiles = Array.from(vaultFilePathsSet).filter(
      (currentFile) => !this.lastVault.has(currentFile),
    );
    const deletedFiles = Array.from(this.lastVault).filter(
      (currentVaultFile) => !vaultFilePathsSet.has(currentVaultFile),
    );

    let changedFiles = Array.from(new Set([...createdFiles, ...deletedFiles]));

    return changedFiles;
  }

  getIndexFile2BRenamed(
    file?: TAbstractFile,
    oldPath?: string,
  ): { file: TFile; newPath: string } | undefined {
    if (!file || !oldPath) return undefined;

    const createdFileSplit = file.path.split("/");
    const deletedFileSplit = oldPath.split("/");
    const createdFileName = file.name;
    const deletedFileName = deletedFileSplit.last();

    // the file itself was renamed, not the folder
    if (createdFileName !== deletedFileName) return undefined;

    // The file was moved to a shallower or deeper nested directory
    if (createdFileSplit.length !== deletedFileSplit.length) return undefined;

    // Find the folder that was renamed
    for (let i = 0; i < createdFileSplit.length; i++) {
      const createdParentFolder = createdFileSplit[i];
      const deletedParentFolder = deletedFileSplit[i];

      // This folder has not changed
      if (createdParentFolder === deletedParentFolder) continue;

      // Is the index file of the old folder still present in the new folder?
      const indexFilePath = `${createdFileSplit.slice(0, i + 1).join("/")}/${
        this.settings.indexPrefix
      }${deletedParentFolder}.md`;
      const folderOrIndexFile =
        this.app.vault.getAbstractFileByPath(indexFilePath);

      // The old index file is still there => folder has been renamed and the file can be deleted
      if (folderOrIndexFile instanceof TFile) {
        const newPath = this.getIndexFilePath(
          `${createdFileSplit.slice(0, i + 1).join("/")}/`,
        );
        return { file: folderOrIndexFile, newPath };
      }

      // If there is no such file, either that folder is excluded or the file was moved there.
      // In both cases there is no action necessary
      return undefined;
    }
  }

  getIndexFiles2BUpdated(changedFiles: string[]) {
    const indexFiles2BUpdated = new Set<string>();

    for (const changedFile of changedFiles) {
      const indexFilePath = this.getIndexFilePath(changedFile);
      if (
        indexFilePath &&
        isInAllowedFolder(this.settings, indexFilePath) &&
        !isInDisAllowedFolder(this.settings, indexFilePath)
      ) {
        indexFiles2BUpdated.add(indexFilePath);
      }

      // getting the parents' index notes of each changed file in order to update their links as well (hierarhical backlinks)
      const parentIndexFilePath = this.getIndexFilePath(
        this.getParentFolder(changedFile),
      );
      if (parentIndexFilePath) indexFiles2BUpdated.add(parentIndexFilePath);
    }

    return indexFiles2BUpdated;
  }

  async renameIndexFile(
    indexFileAndNewPath: { file: TFile; newPath: string } | undefined,
  ) {
    if (!indexFileAndNewPath) return;

    const { file, newPath } = indexFileAndNewPath;

    const newIndexFile = this.app.vault.getAbstractFileByPath(newPath);
    const newIndexFileExists = newIndexFile instanceof TFile;

    if (newIndexFileExists) {
      await this.app.vault.delete(newIndexFile);
    }

    await this.app.vault.rename(file, newPath);
  }

  async updateIndexFiles(indexFiles2BUpdated: Set<string>) {
    await this.removeDisallowedFoldersIndexes(indexFiles2BUpdated);
    // update index files
    for (const indexFile of Array.from(indexFiles2BUpdated)) {
      await this.generateIndexContents(indexFile);
    }
    await this.cleanDisallowedFolders();
  }

  onunload() {
    console.debug("unloading plugin");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  generateIndexContents = async (indexFile: string): Promise<void> => {
    const templateFile = this.app.vault.getAbstractFileByPath(
      this.settings.templateFile,
    );
    let currentTemplateContent = "";

    if (templateFile instanceof TFile) {
      currentTemplateContent = await this.app.vault.cachedRead(templateFile);
    }

    let indexTFile =
      this.app.vault.getAbstractFileByPath(indexFile) ||
      (await this.app.vault.create(indexFile, currentTemplateContent));

    if (indexTFile && indexTFile instanceof TFile)
      return this.generateIndexContent(indexTFile);
  };

  generateGeneralIndexContent = (
    options: GeneralContentOptions,
  ): Array<string> => {
    return options.items.reduce((acc, curr) => {
      acc.push(options.func(curr.path, this.isFile(curr)));
      return acc;
    }, options.initValue);
  };

  generateIndexContent = async (indexTFile: TFile): Promise<void> => {
    let indexContent;
    // get subFolders
    //const subFolders = indexTFile.parent.children.filter(item => !this.isFile(item));
    //const files = indexTFile.parent.children.filter(item => this.isFile(item));

    const splitItems = indexTFile.parent.children.reduce(
      (acc, curr) => {
        if (this.isFile(curr)) acc.files.push(curr);
        else acc["subFolders"].push(curr);
        return acc;
      },
      { subFolders: [] as TAbstractFile[], files: [] as TAbstractFile[] },
    );

    indexContent = this.generateGeneralIndexContent({
      items: splitItems.subFolders,
      func: this.generateIndexFolderItem,
      initValue: [],
    });
    indexContent = this.generateGeneralIndexContent({
      items: splitItems.files.filter((file) => file.name !== indexTFile.name),
      func: this.generateIndexItem,
      initValue: indexContent,
    });

    try {
      if (indexTFile instanceof TFile) {
        let currentContent = await this.app.vault.cachedRead(indexTFile);
        if (currentContent === "") {
          const templateFile = this.app.vault.getAbstractFileByPath(
            this.settings.templateFile,
          );

          if (templateFile instanceof TFile) {
            currentContent = await this.app.vault.cachedRead(templateFile);
          }
        }
        const updatedFrontmatter = hasFrontmatter(
          currentContent,
          this.settings.frontMatterSeparator,
        )
          ? updateFrontmatter(this.settings, currentContent)
          : "";

        currentContent = removeFrontmatter(
          currentContent,
          this.settings.frontMatterSeparator,
        );
        const updatedIndexContent = updateIndexContent(
          this.settings.sortOrder,
          currentContent,
          indexContent,
        );
        await this.app.vault.modify(
          indexTFile,
          `${updatedFrontmatter}${updatedIndexContent}`,
        );
      } else {
        throw new Error("Creation index as folder is not supported");
      }
    } catch (e) {
      console.warn("Error during deletion/creation of index files", e);
    }
  };
  setEmojiPrefix = (isFile: boolean): string => {
    return this.settings.enableEmojis
      ? isFile
        ? emoji.get(this.settings.fileEmoji)
        : emoji.get(this.settings.folderEmoji)
      : "";
  };

  generateFormattedIndexItem = (path: string, isFile: boolean): string => {
    const realFileName = `${path.split("|")[0]}.md`;
    const fileAbstrPath = this.app.vault.getAbstractFileByPath(realFileName);
    if (!fileAbstrPath) return "";
    const embedSubIndexCharacter =
      this.settings.embedSubIndex && this.isIndexFile(fileAbstrPath) ? "!" : "";

    switch (this.settings.indexItemStyle) {
      case IndexItemStyle.PureLink:
        return `${this.setEmojiPrefix(
          isFile,
        )} ${embedSubIndexCharacter}[[${path}]]`;
      case IndexItemStyle.List:
        return `- ${this.setEmojiPrefix(
          isFile,
        )} ${embedSubIndexCharacter}[[${path}]]`;
      case IndexItemStyle.Checkbox:
        return `- [ ] ${this.setEmojiPrefix(
          isFile,
        )} ${embedSubIndexCharacter}[[${path}]]`;
    }
  };

  generateIndexItem = (path: string, isFile: boolean): string => {
    let internalFormattedIndex;
    if (this.settings.cleanPathBoolean) {
      const cleanPath = path.endsWith(".md") ? path.replace(/\.md$/, "") : path;
      const fileName = cleanPath.split("/").pop();
      internalFormattedIndex = `${cleanPath}|${fileName}`;
    } else {
      internalFormattedIndex = path;
    }
    return this.generateFormattedIndexItem(internalFormattedIndex, isFile);
  };

  generateIndexFolderItem = (path: string, isFile: boolean): string => {
    return this.generateIndexItem(this.getInnerIndexFilePath(path), isFile);
  };

  getInnerIndexFilePath = (folderPath: string): string => {
    const folderName = this.getFolderName(folderPath);
    return this.createIndexFilePath(folderPath, folderName);
  };

  getIndexFilePath = (filePath: string): string => {
    const fileAbstrPath = this.app.vault.getAbstractFileByPath(filePath);

    if (!fileAbstrPath || this.isIndexFile(fileAbstrPath)) return "";
    let parentPath = this.getParentFolder(filePath);

    // if its parent does not exits, then its a moved subfolder, so it should not be updated
    const parentTFolder = this.app.vault.getAbstractFileByPath(parentPath);
    if (parentPath && parentPath !== "") {
      if (!parentTFolder) return "";
      parentPath = `${parentPath}/`;
    }
    const parentName = this.getParentFolderName(filePath);

    return this.createIndexFilePath(parentPath, parentName);
  };

  createIndexFilePath = (folderPath: string, folderName: string) => {
    if (!folderPath.endsWith("/") && folderPath !== "") {
      folderPath += "/";
    }
    return `${folderPath}${this.settings.indexPrefix}${folderName}.md`;
  };

  removeDisallowedFoldersIndexes = async (
    indexFiles: Set<string>,
  ): Promise<void> => {
    for (const folder of this.settings.foldersExcluded
      .split("\n")
      .map((f) => f.trim())) {
      const innerIndex = this.getInnerIndexFilePath(folder);
      indexFiles.delete(innerIndex);
    }
  };

  cleanDisallowedFolders = async (): Promise<void> => {
    for (const folder of this.settings.foldersExcluded
      .split("\n")
      .map((f) => f.trim())) {
      const innerIndex = this.getInnerIndexFilePath(folder);
      const indexTFile = this.app.vault.getAbstractFileByPath(innerIndex);
      if (indexTFile) await this.app.vault.delete(indexTFile);
    }
  };

  getParentFolder = (filePath: string): string => {
    const fileFolderArray = filePath.split("/");
    fileFolderArray.pop();

    return fileFolderArray.join("/");
  };

  getParentFolderName = (filePath: string): string => {
    const parentFolder = this.getParentFolder(filePath);
    const fileFolderArray = parentFolder.split("/");
    return fileFolderArray[0] !== ""
      ? fileFolderArray[fileFolderArray.length - 1]
      : this.app.vault.getName();
  };

  getFolderName = (folderPath: string): string => {
    const folderArray = folderPath.split("/");
    return folderArray[0] !== ""
      ? folderArray[folderArray.length - 1]
      : this.app.vault.getName();
  };

  isIndexFile = (item: TAbstractFile): boolean => {
    return (
      this.isFile(item) &&
      item.name === `${this.settings.indexPrefix}${item.parent.name}`
    );
  };

  isFile = (item: TAbstractFile): boolean => {
    return item instanceof TFile;
  };
}

class ZoottelkeeperPluginModal extends Modal {
  constructor(app: App) {
    super(app);
  }
}

class ZoottelkeeperPluginSettingTab extends PluginSettingTab {
  plugin: ZoottelkeeperPlugin;

  constructor(app: App, plugin: ZoottelkeeperPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();
    containerEl.createEl("h3", { text: i18next.t("folder") });

    new Setting(containerEl)
      .setName(i18next.t("folders_included"))
      .setDesc(i18next.t("folders_included_desc"))
      .addTextArea((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.foldersIncluded)
          .onChange(async (value) => {
            this.plugin.settings.foldersIncluded = value
              .replace(/,/g, "\n")
              .split("\n")
              .map((folder) => {
                const f = folder.trim();
                return f.startsWith("/") ? f.substring(1) : f;
              })
              .join("\n");
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName(i18next.t("folders_excluded"))
      .setDesc(i18next.t("folders_excluded_desc"))
      .addTextArea((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.foldersExcluded)
          .onChange(async (value) => {
            this.plugin.settings.foldersExcluded = value
              .replace(/,/g, "\n")
              .split("\n")
              .map((folder) => {
                const f = folder.trim();
                return f.startsWith("/") ? f.substring(1) : f;
              })
              .join("\n");
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName(i18next.t("trigger_indexing"))
      .setDesc(i18next.t("trigger_indexing_desc"))
      .addButton((btn) => {
        btn.setButtonText(i18next.t("generate_index_now"));
        btn.onClick(async () => {
          this.plugin.lastVault = new Set();
          await this.plugin.keepTheZooClean(true);
        });
      });

    containerEl.createEl("h3", { text: i18next.t("general") });
    new Setting(containerEl)
      .setName(i18next.t("clean_files"))
      .setDesc(i18next.t("clean_files_desc"))
      .addToggle((t) => {
        t.setValue(this.plugin.settings.cleanPathBoolean);
        t.onChange(async (v) => {
          this.plugin.settings.cleanPathBoolean = v;
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName(i18next.t("index_links_order"))
      .setDesc(i18next.t("index_links_order_desc"))
      .addDropdown(async (dropdown) => {
        dropdown.addOption(SortOrder.ASC, i18next.t("ascending"));
        dropdown.addOption(SortOrder.DESC, i18next.t("descending"));

        dropdown.setValue(this.plugin.settings.sortOrder);
        dropdown.onChange(async (option) => {
          this.plugin.settings.sortOrder = option as SortOrder;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(i18next.t("list_style"))
      .setDesc(i18next.t("list_style_desc"))
      .addDropdown(async (dropdown) => {
        dropdown.addOption(
          IndexItemStyle.PureLink,
          i18next.t("pure_obsidian_link"),
        );
        dropdown.addOption(IndexItemStyle.List, i18next.t("listed_link"));
        dropdown.addOption(
          IndexItemStyle.Checkbox,
          i18next.t("checkboxed_link"),
        );

        dropdown.setValue(this.plugin.settings.indexItemStyle);
        dropdown.onChange(async (option) => {
          this.plugin.settings.indexItemStyle = option as IndexItemStyle;
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName(i18next.t("embed_sub_index_content_in_preview"))
      .setDesc(i18next.t("embed_sub_index_content_in_preview_desc"))
      .addToggle((t) => {
        t.setValue(this.plugin.settings.embedSubIndex);
        t.onChange(async (v) => {
          this.plugin.settings.embedSubIndex = v;
          await this.plugin.saveSettings();
        });
      });

    // index prefix
    new Setting(containerEl)
      .setName(i18next.t("index_prefix"))
      .setDesc(i18next.t("index_prefix_desc"))
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.indexPrefix)
          .onChange(async (value) => {
            console.debug("Index prefix: " + value);
            this.plugin.settings.indexPrefix = value;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName(i18next.t("template_file"))
      .setDesc(i18next.t("template_file_desc"))
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.templateFile)
          .onChange(async (value) => {
            console.debug("Template file: " + value);
            this.plugin.settings.templateFile = value;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName(i18next.t("frontmatter_separator"))
      .setDesc(i18next.t("frontmatter_separator_desc"))
      .addText((text) =>
        text
          .setPlaceholder("")
          .setValue(this.plugin.settings.frontMatterSeparator)
          .onChange(async (value) => {
            this.plugin.settings.frontMatterSeparator = value;
            await this.plugin.saveSettings();
          }),
      );
    containerEl.createEl("h4", { text: i18next.t("meta_tags") });

    // Enabling Meta Tags
    new Setting(containerEl)
      .setName(i18next.t("enable_meta_tags"))
      .setDesc(i18next.t("enable_meta_tags_desc"))
      .addToggle((t) => {
        t.setValue(this.plugin.settings.indexTagBoolean);
        t.onChange(async (v) => {
          this.plugin.settings.indexTagBoolean = v;
          await this.plugin.saveSettings();
        });
      });

    // setting the meta tag value
    const metaTagsSetting = new Setting(containerEl)
      .setName(i18next.t("set_meta_tags"))
      .setDesc(i18next.t("set_meta_tags_desc"))
      .addText((text) =>
        text
          .setPlaceholder("MOC")
          .setValue(this.plugin.settings.indexTagValue)
          .onChange(async (value) => {
            this.plugin.settings.indexTagValue = value;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName(i18next.t("set_the_tag_s_label_in_frontmatter"))
      .setDesc(i18next.t("set_the_tag_s_label_in_frontmatter_desc"))
      .addText((text) =>
        text
          .setPlaceholder("tags")
          .setValue(this.plugin.settings.indexTagLabel)
          .onChange(async (value) => {
            this.plugin.settings.indexTagLabel = value;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName(i18next.t("set_the_tag_s_separator_in_frontmatter"))
      .setDesc(i18next.t("set_the_tag_s_separator_in_frontmatter_desc"))
      .addText((text) =>
        text
          .setPlaceholder(", ")
          .setValue(this.plugin.settings.indexTagSeparator)
          .onChange(async (value) => {
            this.plugin.settings.indexTagSeparator = value;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName(i18next.t("add_square_brackets_around_each_tags"))
      .setDesc(i18next.t("add_square_brackets_around_each_tags_desc"))
      .addToggle((t) => {
        t.setValue(this.plugin.settings.addSquareBrackets);
        t.onChange(async (v) => {
          this.plugin.settings.addSquareBrackets = v;
          await this.plugin.saveSettings();
        });
      });
    containerEl.createEl("h4", { text: i18next.t("emojis") });

    // Enabling Meta Tags
    new Setting(containerEl)
      .setName(i18next.t("enable_emojis"))
      .setDesc(i18next.t("enable_emojis_desc"))
      .addToggle((t) => {
        t.setValue(this.plugin.settings.enableEmojis);
        t.onChange(async (v) => {
          this.plugin.settings.enableEmojis = v;
          await this.plugin.saveSettings();
        });
      });

    let emojiFolderDesc = i18next.t("set_an_emoji_for_folders");
    if (this.plugin.settings.folderEmoji) {
      const setFolderEmoji = emoji.search(this.plugin.settings.folderEmoji);
      emojiFolderDesc = `${i18next.t("matching_options")} ${
        setFolderEmoji[0]?.emoji
      } (${setFolderEmoji[0]?.key})`;
    }
    const emojiForFoldersSetting = new Setting(containerEl)
      .setName(i18next.t("emoji_for_folders"))
      .setDesc(emojiFolderDesc)
      .addText((text) =>
        text
          .setPlaceholder("card_index_dividers")
          .setValue(this.plugin.settings.folderEmoji.replace(/:/g, ""))
          .onChange(async (value) => {
            if (value !== "") {
              const emojiOptions = emoji.search(value);
              emojiForFoldersSetting.setDesc(
                `${i18next.t("matching_options")} ${emojiOptions.map(
                  (emojOp) => emojOp.emoji + "(" + emojOp.key + ")",
                )}`,
              );
              if (emojiOptions.length > 0) {
                this.plugin.settings.folderEmoji = `:${emojiOptions[0]?.key}:`;
                await this.plugin.saveSettings();
              }
            } else {
              emojiForFoldersSetting.setDesc(
                i18next.t("set_an_emoji_for_folders"),
              );
            }
          }),
      );
    let emojiFileDesc = i18next.t("set_an_emoji_for_files");
    if (this.plugin.settings.fileEmoji) {
      const setFileEmoji = emoji.search(this.plugin.settings.fileEmoji);
      emojiFileDesc = `${i18next.t("matching_options")}${
        setFileEmoji[0].emoji
      } (${setFileEmoji[0].key})`;
    }

    const emojiForFilesSetting = new Setting(containerEl)
      .setName(i18next.t("emoji_for_files"))
      .setDesc(emojiFileDesc)
      .addText((text) =>
        text
          .setPlaceholder("page_facing_up")
          .setValue(this.plugin.settings.fileEmoji.replace(/:/g, ""))
          .onChange(async (value) => {
            if (value !== "") {
              const emojiOptions = emoji.search(value);
              emojiForFilesSetting.setDesc(
                `${i18next.t("set_an_emoji_for_folders")}${emojiOptions.map(
                  (emojOp) => emojOp.emoji + "(" + emojOp.key + ")",
                )}`,
              );
              if (emojiOptions.length > 0) {
                this.plugin.settings.fileEmoji = `:${emojiOptions[0].key}:`;
                await this.plugin.saveSettings();
              }
            } else {
              emojiForFilesSetting.setDesc(i18next.t("set_an_emoji_for_files"));
            }
          }),
      );
  }
}
