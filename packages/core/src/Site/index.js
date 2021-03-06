const cheerio = require('cheerio'); require('../patches/htmlparser2');
const fs = require('fs-extra');
const ghpages = require('gh-pages');
const ignore = require('ignore');
const path = require('path');
const Promise = require('bluebird');
const ProgressBar = require('progress');
const walkSync = require('walk-sync');
const simpleGit = require('simple-git');

const SiteConfig = require('./SiteConfig');
const Page = require('../Page');
const { PageConfig } = require('../Page/PageConfig');
const VariableProcessor = require('../variables/VariableProcessor');
const VariableRenderer = require('../variables/VariableRenderer');
const { ignoreTags } = require('../patches');
const Template = require('../../template/template');

const FsUtil = require('../utils/fsUtil');
const delay = require('../utils/delay');
const logger = require('../utils/logger');
const utils = require('../utils');
const gitUtil = require('../utils/git');

const {
  LAYOUT_DEFAULT_NAME,
  LAYOUT_FOLDER_PATH,
  PLUGIN_SITE_ASSET_FOLDER_NAME,
} = require('../constants');

const _ = {};
_.difference = require('lodash/difference');
_.flatMap = require('lodash/flatMap');
_.get = require('lodash/get');
_.has = require('lodash/has');
_.includes = require('lodash/includes');
_.isBoolean = require('lodash/isBoolean');
_.isUndefined = require('lodash/isUndefined');
_.noop = require('lodash/noop');
_.omitBy = require('lodash/omitBy');
_.startCase = require('lodash/startCase');
_.union = require('lodash/union');
_.uniq = require('lodash/uniq');

const url = {};
url.join = path.posix.join;

const MARKBIND_VERSION = require('../../package.json').version;

const {
  ABOUT_MARKDOWN_FILE,
  CONFIG_FOLDER_NAME,
  FAVICON_DEFAULT_PATH,
  FOOTER_PATH,
  INDEX_MARKDOWN_FILE,
  LAYOUT_SITE_FOLDER_NAME,
  LAZY_LOADING_SITE_FILE_NAME,
  LAZY_LOADING_BUILD_TIME_RECOMMENDATION_LIMIT,
  LAZY_LOADING_REBUILD_TIME_RECOMMENDATION_LIMIT,
  MARKBIND_DEFAULT_PLUGIN_DIRECTORY,
  MARKBIND_PLUGIN_DIRECTORY,
  MARKBIND_PLUGIN_PREFIX,
  MARKBIND_WEBSITE_URL,
  MAX_CONCURRENT_PAGE_GENERATION_PROMISES,
  PAGE_TEMPLATE_NAME,
  PROJECT_PLUGIN_FOLDER_NAME,
  SITE_CONFIG_NAME,
  SITE_DATA_NAME,
  SITE_FOLDER_NAME,
  TEMP_FOLDER_NAME,
  TEMPLATE_SITE_ASSET_FOLDER_NAME,
  USER_VARIABLES_PATH,
  WIKI_SITE_NAV_PATH,
  WIKI_FOOTER_PATH,
} = require('./constants');

function getBootswatchThemePath(theme) {
  return require.resolve(`bootswatch/dist/${theme}/bootstrap.min.css`);
}

const SUPPORTED_THEMES_PATHS = {
  'bootswatch-cerulean': getBootswatchThemePath('cerulean'),
  'bootswatch-cosmo': getBootswatchThemePath('cosmo'),
  'bootswatch-flatly': getBootswatchThemePath('flatly'),
  'bootswatch-journal': getBootswatchThemePath('journal'),
  'bootswatch-litera': getBootswatchThemePath('litera'),
  'bootswatch-lumen': getBootswatchThemePath('lumen'),
  'bootswatch-lux': getBootswatchThemePath('lux'),
  'bootswatch-materia': getBootswatchThemePath('materia'),
  'bootswatch-minty': getBootswatchThemePath('minty'),
  'bootswatch-pulse': getBootswatchThemePath('pulse'),
  'bootswatch-sandstone': getBootswatchThemePath('sandstone'),
  'bootswatch-simplex': getBootswatchThemePath('simplex'),
  'bootswatch-sketchy': getBootswatchThemePath('sketchy'),
  'bootswatch-spacelab': getBootswatchThemePath('spacelab'),
  'bootswatch-united': getBootswatchThemePath('united'),
  'bootswatch-yeti': getBootswatchThemePath('yeti'),
};

const HIGHLIGHT_ASSETS = {
  dark: 'codeblock-dark.min.css',
  light: 'codeblock-light.min.css',
};

const ABOUT_MARKDOWN_DEFAULT = '# About\n'
  + 'Welcome to your **About Us** page.\n';

const TOP_NAV_DEFAULT = '<header><navbar placement="top" type="inverse">\n'
  + '  <a slot="brand" href="{{baseUrl}}/index.html" title="Home" class="navbar-brand">'
  + '<i class="far fa-file-image"></i></a>\n'
  + '  <li><a href="{{baseUrl}}/index.html" class="nav-link">HOME</a></li>\n'
  + '  <li><a href="{{baseUrl}}/about.html" class="nav-link">ABOUT</a></li>\n'
  + '  <li slot="right">\n'
  + '    <form class="navbar-form">\n'
  + '      <searchbar :data="searchData" placeholder="Search" :on-hit="searchCallback"'
  + ' menu-align-right></searchbar>\n'
  + '    </form>\n'
  + '  </li>\n'
  + '</navbar></header>';

const MARKBIND_LINK_HTML = `<a href='${MARKBIND_WEBSITE_URL}'>MarkBind ${MARKBIND_VERSION}</a>`;

class Site {
  constructor(rootPath, outputPath, onePagePath, forceReload = false,
              siteConfigPath = SITE_CONFIG_NAME, dev) {
    this.dev = !!dev;

    this.rootPath = rootPath;
    this.outputPath = outputPath;
    this.tempPath = path.join(rootPath, TEMP_FOLDER_NAME);

    // MarkBind assets to be copied
    this.siteAssetsDestPath = path.join(outputPath, TEMPLATE_SITE_ASSET_FOLDER_NAME);

    // Page template path
    this.pageTemplatePath = path.join(__dirname, '../Page', PAGE_TEMPLATE_NAME);
    this.pageTemplate = VariableRenderer.compile(fs.readFileSync(this.pageTemplatePath, 'utf8'));
    this.pages = [];

    // Other properties
    this.addressablePages = [];
    this.addressablePagesSource = [];
    this.baseUrlMap = new Set();
    this.forceReload = forceReload;
    this.plugins = {};
    this.pluginsBeforeSiteGenerate = [];
    /**
     * @type {undefined | SiteConfig}
     */
    this.siteConfig = undefined;
    this.siteConfigPath = siteConfigPath;

    // Site wide variable processor
    this.variableProcessor = undefined;

    // Lazy reload properties
    this.onePagePath = onePagePath;
    this.currentPageViewed = onePagePath
      ? path.resolve(this.rootPath, FsUtil.removeExtension(onePagePath))
      : '';
    this.toRebuild = new Set();
  }

  /**
   * Util Methods
   */

  static rejectHandler(error, removeFolders) {
    logger.warn(error);
    return Promise.all(removeFolders.map(folder => fs.remove(folder)))
      .catch((err) => {
        logger.error(`Failed to remove generated files after error!\n${err.message}`);
      });
  }

  static setExtension(filename, ext) {
    return path.join(
      path.dirname(filename),
      path.basename(filename, path.extname(filename)) + ext,
    );
  }

  /**
   * Static method for initializing a markbind site.
   * Generate the site.json and an index.md file.
   *
   * @param rootPath
   * @param templatePath
   */
  static initSite(rootPath, templatePath) {
    return new Promise((resolve, reject) => {
      new Template(rootPath, templatePath).init()
        .then(resolve)
        .catch((err) => {
          reject(new Error(`Failed to initialize site with given template with error: ${err.message}`));
        });
    });
  }

  /**
   * Changes the site variable of the current page being viewed, building it if necessary.
   * @param normalizedUrl BaseUrl-less and extension-less url of the page
   * @return Boolean of whether the page needed to be rebuilt
   */
  changeCurrentPage(normalizedUrl) {
    this.currentPageViewed = path.join(this.rootPath, normalizedUrl);

    if (this.toRebuild.has(this.currentPageViewed)) {
      this.rebuildPageBeingViewed(this.currentPageViewed);
      return true;
    }

    return false;
  }

  /**
   * Read and store the site config from site.json, overwrite the default base URL
   * if it's specified by the user.
   * @param baseUrl user defined base URL (if exists)
   * @returns {Promise}
   */
  async readSiteConfig(baseUrl) {
    try {
      const siteConfigPath = path.join(this.rootPath, this.siteConfigPath);
      const siteConfigJson = fs.readJsonSync(siteConfigPath);
      this.siteConfig = new SiteConfig(siteConfigJson, baseUrl);

      return this.siteConfig;
    } catch (err) {
      throw (new Error(`Failed to read the site config file '${this.siteConfigPath}' at`
        + `${this.rootPath}:\n${err.message}\nPlease ensure the file exist or is valid`));
    }
  }

  listAssets(fileIgnore) {
    return new Promise((resolve, reject) => {
      let files;
      try {
        files = walkSync(this.rootPath, { directories: false });
        resolve(fileIgnore.filter(files));
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * A page configuration object.
   * @typedef {Object<string, any>} PageCreationConfig
   * @property {string} faviconUrl
   * @property {string} pageSrc
   * @property {string} title
   * @property {string} layout
   * @property {Object<string, any>} frontmatter
   * @property {boolean} searchable
   * @property {Array<string>} externalScripts
   * /

  /**
   * Create a Page object from the site and page creation config.
   * @param {PageCreationConfig} config
   * @returns {Page}
   */
  createPage(config) {
    const sourcePath = path.join(this.rootPath, config.pageSrc);
    const resultPath = path.join(this.outputPath, Site.setExtension(config.pageSrc, '.html'));
    const codeTheme = this.siteConfig.style.codeTheme || 'dark';
    const pageConfig = new PageConfig({
      asset: {
        bootstrap: path.relative(path.dirname(resultPath),
                                 path.join(this.siteAssetsDestPath, 'css', 'bootstrap.min.css')),
        bootstrapVueCss: path.relative(path.dirname(resultPath),
                                       path.join(this.siteAssetsDestPath, 'css', 'bootstrap-vue.min.css')),
        externalScripts: _.union(this.siteConfig.externalScripts, config.externalScripts),
        fontAwesome: path.relative(path.dirname(resultPath),
                                   path.join(this.siteAssetsDestPath, 'fontawesome', 'css', 'all.min.css')),
        glyphicons: path.relative(path.dirname(resultPath),
                                  path.join(this.siteAssetsDestPath, 'glyphicons', 'css',
                                            'bootstrap-glyphicons.min.css')),
        octicons: path.relative(path.dirname(resultPath),
                                path.join(this.siteAssetsDestPath, 'css', 'octicons.css')),
        highlight: path.relative(path.dirname(resultPath),
                                 path.join(this.siteAssetsDestPath, 'css', HIGHLIGHT_ASSETS[codeTheme])),
        markBindCss: path.relative(path.dirname(resultPath),
                                   path.join(this.siteAssetsDestPath, 'css', 'markbind.min.css')),
        markBindJs: path.relative(path.dirname(resultPath),
                                  path.join(this.siteAssetsDestPath, 'js', 'markbind.min.js')),
        pageNavCss: path.relative(path.dirname(resultPath),
                                  path.join(this.siteAssetsDestPath, 'css', 'page-nav.css')),
        siteNavCss: path.relative(path.dirname(resultPath),
                                  path.join(this.siteAssetsDestPath, 'css', 'site-nav.css')),
        bootstrapUtilityJs: path.relative(path.dirname(resultPath),
                                          path.join(this.siteAssetsDestPath, 'js',
                                                    'bootstrap-utility.min.js')),
        polyfillJs: path.relative(path.dirname(resultPath),
                                  path.join(this.siteAssetsDestPath, 'js', 'polyfill.min.js')),
        vue: path.relative(path.dirname(resultPath),
                           path.join(this.siteAssetsDestPath, 'js', 'vue.min.js')),
        jQuery: path.relative(path.dirname(resultPath),
                              path.join(this.siteAssetsDestPath, 'js', 'jquery.min.js')),
      },
      baseUrl: this.siteConfig.baseUrl,
      baseUrlMap: this.baseUrlMap,
      dev: this.dev,
      disableHtmlBeautify: this.siteConfig.disableHtmlBeautify,
      enableSearch: this.siteConfig.enableSearch,
      faviconUrl: config.faviconUrl,
      frontmatterOverride: config.frontmatter,
      globalOverride: this.siteConfig.globalOverride,
      headingIndexingLevel: this.siteConfig.headingIndexingLevel,
      layout: config.layout,
      layoutsAssetPath: path.relative(path.dirname(resultPath),
                                      path.join(this.siteAssetsDestPath, LAYOUT_SITE_FOLDER_NAME)),
      plugins: this.plugins || {},
      pluginsContext: this.siteConfig.pluginsContext,
      resultPath,
      rootPath: this.rootPath,
      searchable: this.siteConfig.enableSearch && config.searchable,
      siteOutputPath: this.outputPath,
      sourcePath,
      src: config.pageSrc,
      title: config.title || '',
      titlePrefix: this.siteConfig.titlePrefix,
      template: this.pageTemplate,
      variableProcessor: this.variableProcessor,
      ignore: this.siteConfig.ignore,
      addressablePagesSource: this.addressablePagesSource,
    });
    return new Page(pageConfig);
  }

  /**
   * Converts an existing GitHub wiki or docs folder to a MarkBind website.
   */
  convert() {
    return this.readSiteConfig()
      .then(() => this.collectAddressablePages())
      .then(() => this.addIndexPage())
      .then(() => this.addAboutPage())
      .then(() => this.addTopNavToDefaultLayout())
      .then(() => this.addFooterToDefaultLayout())
      .then(() => this.addSiteNavToDefaultLayout())
      .then(() => this.addDefaultLayoutToSiteConfig())
      .then(() => Site.printBaseUrlMessage());
  }

  /**
   * Copies over README.md or Home.md to default index.md if present.
   */
  addIndexPage() {
    const indexPagePath = path.join(this.rootPath, INDEX_MARKDOWN_FILE);
    const fileNames = ['README.md', 'Home.md'];
    const filePath = fileNames.find(fileName => fs.existsSync(path.join(this.rootPath, fileName)));
    // if none of the files exist, do nothing
    if (_.isUndefined(filePath)) return Promise.resolve();
    return fs.copy(path.join(this.rootPath, filePath), indexPagePath)
      .catch(() => Promise.reject(new Error(`Failed to copy over ${filePath}`)));
  }

  /**
   * Adds an about page to site if not present.
   */
  addAboutPage() {
    const aboutPath = path.join(this.rootPath, ABOUT_MARKDOWN_FILE);
    return fs.access(aboutPath)
      .catch(() => {
        if (fs.existsSync(aboutPath)) {
          return Promise.resolve();
        }
        return fs.outputFile(aboutPath, ABOUT_MARKDOWN_DEFAULT);
      });
  }

  /**
   * Adds top navigation menu to default layout of site.
   */
  addTopNavToDefaultLayout() {
    const siteLayoutPath = path.join(this.rootPath, LAYOUT_FOLDER_PATH);
    const siteLayoutHeaderDefaultPath = path.join(siteLayoutPath, LAYOUT_DEFAULT_NAME, 'header.md');

    return fs.outputFile(siteLayoutHeaderDefaultPath, TOP_NAV_DEFAULT);
  }

  /**
   * Adds a footer to default layout of site.
   */
  addFooterToDefaultLayout() {
    const footerPath = path.join(this.rootPath, FOOTER_PATH);
    const siteLayoutPath = path.join(this.rootPath, LAYOUT_FOLDER_PATH);
    const siteLayoutFooterDefaultPath = path.join(siteLayoutPath, LAYOUT_DEFAULT_NAME, 'footer.md');
    const wikiFooterPath = path.join(this.rootPath, WIKI_FOOTER_PATH);

    return fs.access(wikiFooterPath)
      .then(() => {
        const footerContent = fs.readFileSync(wikiFooterPath, 'utf8');
        const wrappedFooterContent = `<footer>\n\t${footerContent}\n</footer>`;
        return fs.outputFile(siteLayoutFooterDefaultPath, wrappedFooterContent);
      })
      .catch(() => {
        if (fs.existsSync(footerPath)) {
          return fs.copy(footerPath, siteLayoutFooterDefaultPath);
        }
        return Promise.resolve();
      });
  }

  /**
   * Adds a site navigation bar to the default layout of the site.
   */
  addSiteNavToDefaultLayout() {
    const siteLayoutPath = path.join(this.rootPath, LAYOUT_FOLDER_PATH);
    const siteLayoutSiteNavDefaultPath = path.join(siteLayoutPath, LAYOUT_DEFAULT_NAME, 'navigation.md');
    const wikiSiteNavPath = path.join(this.rootPath, WIKI_SITE_NAV_PATH);

    return fs.access(wikiSiteNavPath)
      .then(() => {
        const siteNavContent = fs.readFileSync(wikiSiteNavPath, 'utf8');
        const wrappedSiteNavContent = `<navigation>\n${siteNavContent}\n</navigation>`;
        logger.info(`Copied over the existing _Sidebar.md file to ${path.relative(
          this.rootPath, siteLayoutSiteNavDefaultPath)}`
          + 'Check https://markbind.org/userGuide/tweakingThePageStructure.html#site-navigation-menus\n'
          + 'for information on site navigation menus.');
        return fs.outputFileSync(siteLayoutSiteNavDefaultPath, wrappedSiteNavContent);
      })
      .catch(() => this.buildSiteNav(siteLayoutSiteNavDefaultPath));
  }

  /**
   * Builds a site navigation file from the directory structure of the site.
   * @param siteLayoutSiteNavDefaultPath
   */
  buildSiteNav(siteLayoutSiteNavDefaultPath) {
    let siteNavContent = '';
    this.addressablePages
      .filter(addressablePage => !addressablePage.src.startsWith('_'))
      .forEach((page) => {
        const addressablePagePath = path.join(this.rootPath, page.src);
        const relativePagePathWithoutExt = FsUtil.removeExtension(
          path.relative(this.rootPath, addressablePagePath));
        const pageName = _.startCase(FsUtil.removeExtension(path.basename(addressablePagePath)));
        const pageUrl = `{{ baseUrl }}/${relativePagePathWithoutExt}.html`;
        siteNavContent += `* [${pageName}](${pageUrl})\n`;
      });
    const wrappedSiteNavContent = `<navigation>\n${siteNavContent}\n</navigation>`;
    return fs.outputFile(siteLayoutSiteNavDefaultPath, wrappedSiteNavContent);
  }

  /**
   * Applies the default layout to all addressable pages by modifying the site config file.
   */
  addDefaultLayoutToSiteConfig() {
    const configPath = path.join(this.rootPath, SITE_CONFIG_NAME);
    return fs.readJson(configPath)
      .then((config) => {
        const layoutObj = { glob: '**/*.+(md|mbd)', layout: LAYOUT_DEFAULT_NAME };
        config.pages.push(layoutObj);
        return fs.outputJson(configPath, config);
      });
  }

  static printBaseUrlMessage() {
    logger.info('The default base URL of your site is set to /\n'
      + 'You can change the base URL of your site by editing site.json\n'
      + 'Check https://markbind.org/userGuide/siteConfiguration.html for more information.');
    return Promise.resolve();
  }

  /**
   * Updates the paths to be traversed as addressable pages and returns a list of filepaths to be deleted
   */
  updateAddressablePages() {
    const oldAddressablePagesSources = this.addressablePages.slice().map(page => page.src);
    this.collectAddressablePages();
    const newAddressablePagesSources = this.addressablePages.map(page => page.src);

    return _.difference(oldAddressablePagesSources, newAddressablePagesSources)
      .map(filePath => Site.setExtension(filePath, '.html'));
  }

  getPageGlobPaths(page, pagesExclude) {
    return walkSync(this.rootPath, {
      directories: false,
      globs: Array.isArray(page.glob) ? page.glob : [page.glob],
      ignore: [
        CONFIG_FOLDER_NAME,
        SITE_FOLDER_NAME,
        ...pagesExclude.concat(page.globExclude || []),
      ],
    });
  }

  /**
   * Collects the paths to be traversed as addressable pages
   */
  collectAddressablePages() {
    const { pages, pagesExclude } = this.siteConfig;
    const pagesFromSrc = _.flatMap(pages.filter(page => page.src), page => (Array.isArray(page.src)
      ? page.src.map(pageSrc => ({ ...page, src: pageSrc }))
      : [page]));
    const set = new Set();
    const duplicatePages = pagesFromSrc
      .filter(page => set.size === set.add(page.src).size)
      .map(page => page.src);
    if (duplicatePages.length > 0) {
      return Promise.reject(
        new Error(`Duplicate page entries found in site config: ${_.uniq(duplicatePages).join(', ')}`));
    }
    const pagesFromGlobs = _.flatMap(pages.filter(page => page.glob),
                                     page => this.getPageGlobPaths(page, pagesExclude)
                                       .map(filePath => ({
                                         src: filePath,
                                         searchable: page.searchable,
                                         layout: page.layout,
                                         frontmatter: page.frontmatter,
                                       })));
    /*
     Add pages collected from globs and merge properties for pages
     Page properties collected from src have priority over page properties from globs,
     while page properties from later entries take priority over earlier ones.
     */
    const filteredPages = {};
    pagesFromGlobs.concat(pagesFromSrc).forEach((page) => {
      const filteredPage = _.omitBy(page, _.isUndefined);
      filteredPages[page.src] = page.src in filteredPages
        ? { ...filteredPages[page.src], ...filteredPage }
        : filteredPage;
    });
    this.addressablePages = Object.values(filteredPages);
    this.addressablePagesSource.length = 0;
    this.addressablePages.forEach((page) => {
      this.addressablePagesSource.push(FsUtil.removeExtensionPosix(page.src));
    });

    return Promise.resolve();
  }

  /**
   * Collects the base url map in the site/subsites
   * @returns {*}
   */
  collectBaseUrl() {
    const candidates = walkSync(this.rootPath, { directories: false })
      .filter(x => x.endsWith(this.siteConfigPath))
      .map(x => path.resolve(this.rootPath, x));

    this.baseUrlMap = new Set(candidates.map(candidate => path.dirname(candidate)));
    this.variableProcessor = new VariableProcessor(this.rootPath, this.baseUrlMap);

    return Promise.resolve();
  }

  /**
   * Collects the user defined variables map in the site/subsites
   */
  collectUserDefinedVariablesMap() {
    this.variableProcessor.resetUserDefinedVariablesMap();

    this.baseUrlMap.forEach((base) => {
      const userDefinedVariablesPath = path.resolve(base, USER_VARIABLES_PATH);
      let content;
      try {
        content = fs.readFileSync(userDefinedVariablesPath, 'utf8');
      } catch (e) {
        content = '';
        logger.warn(e.message);
      }

      /*
       We retrieve the baseUrl of the (sub)site by appending the relative to the configured base url
       i.e. We ignore the configured baseUrl of the sub sites.
       */
      const siteRelativePathFromRoot = utils.ensurePosix(path.relative(this.rootPath, base));
      const siteBaseUrl = siteRelativePathFromRoot === ''
        ? this.siteConfig.baseUrl
        : path.posix.join(this.siteConfig.baseUrl || '/', siteRelativePathFromRoot);
      this.variableProcessor.addUserDefinedVariable(base, 'baseUrl', siteBaseUrl);
      this.variableProcessor.addUserDefinedVariable(base, 'MarkBind', MARKBIND_LINK_HTML);

      const $ = cheerio.load(content, { decodeEntities: false });
      $('variable,span').each((index, element) => {
        const name = $(element).attr('name') || $(element).attr('id');

        this.variableProcessor.renderAndAddUserDefinedVariable(base, name, $(element).html());
      });
    });
  }

  /**
   * Collects the user defined variables map in the site/subsites
   * if there is a change in the variables file
   * @param filePaths array of paths corresponding to files that have changed
   */
  collectUserDefinedVariablesMapIfNeeded(filePaths) {
    const variablesPath = path.resolve(this.rootPath, USER_VARIABLES_PATH);
    if (filePaths.includes(variablesPath)) {
      this.collectUserDefinedVariablesMap();
      return true;
    }
    return false;
  }

  /**
   * Generate the website.
   * @param baseUrl user defined base URL (if exists)
   * @returns {Promise}
   */
  generate(baseUrl) {
    const startTime = new Date();
    // Create the .tmp folder for storing intermediate results.
    fs.emptydirSync(this.tempPath);
    // Clean the output folder; create it if not exist.
    fs.emptydirSync(this.outputPath);
    const lazyWebsiteGenerationString = this.onePagePath ? '(lazy) ' : '';
    logger.info(`Website generation ${lazyWebsiteGenerationString}started at ${
      startTime.toLocaleTimeString()}`);

    return this.readSiteConfig(baseUrl)
      .then(() => this.collectAddressablePages())
      .then(() => this.collectBaseUrl())
      .then(() => this.collectUserDefinedVariablesMap())
      .then(() => this.collectPlugins())
      .then(() => this.collectPluginSiteHooks())
      .then(() => this.collectPluginSpecialTags())
      .then(() => this.buildAssets())
      .then(() => (this.onePagePath ? this.lazyBuildSourceFiles() : this.buildSourceFiles()))
      .then(() => this.copyCoreWebAsset())
      .then(() => this.copyBootswatchTheme())
      .then(() => this.copyFontAwesomeAsset())
      .then(() => this.copyOcticonsAsset())
      .then(() => this.copyLayouts())
      .then(() => this.writeSiteData())
      .then(() => {
        const endTime = new Date();
        const totalBuildTime = (endTime - startTime) / 1000;
        logger.info(`Website generation ${lazyWebsiteGenerationString}complete! Total build time: ${
          totalBuildTime}s`);

        if (!this.onePagePath && totalBuildTime > LAZY_LOADING_BUILD_TIME_RECOMMENDATION_LIMIT) {
          logger.info('Your site took quite a while to build...'
              + 'Have you considered using markbind serve -o when writing content to speed things up?');
        }
      })
      .catch(error => Site.rejectHandler(error, [this.tempPath, this.outputPath]));
  }

  /**
   * Build all pages of the site
   */
  buildSourceFiles() {
    this.runBeforeSiteGenerateHooks();
    logger.info('Generating pages...');

    return this.generatePages()
      .then(() => fs.remove(this.tempPath))
      .then(() => logger.info('Pages built'))
      .catch(error => Site.rejectHandler(error, [this.tempPath, this.outputPath]));
  }

  /**
   * Adds all pages except the current page being viewed to toRebuild, flagging them for lazy building later.
   */
  lazyBuildAllPagesNotViewed() {
    this.pages.forEach((page) => {
      const normalizedUrl = FsUtil.removeExtension(page.pageConfig.sourcePath);
      if (normalizedUrl !== this.currentPageViewed) {
        this.toRebuild.add(normalizedUrl);
      }
    });

    return Promise.resolve();
  }

  /**
   * Only build landing page of the site, building more as the author goes to different links.
   */
  lazyBuildSourceFiles() {
    this.runBeforeSiteGenerateHooks();
    logger.info('Generating landing page...');

    return this.generateLandingPage()
      .then(() => {
        const lazyLoadingSpinnerHtmlFilePath = path.join(__dirname, LAZY_LOADING_SITE_FILE_NAME);
        const outputSpinnerHtmlFilePath = path.join(this.outputPath, LAZY_LOADING_SITE_FILE_NAME);

        return fs.copy(lazyLoadingSpinnerHtmlFilePath, outputSpinnerHtmlFilePath);
      })
      .then(() => fs.remove(this.tempPath))
      .then(() => this.lazyBuildAllPagesNotViewed())
      .then(() => logger.info('Landing page built, other pages will be built as you navigate to them!'))
      .catch(error => Site.rejectHandler(error, [this.tempPath, this.outputPath]));
  }

  _rebuildAffectedSourceFiles(filePaths) {
    const filePathArray = Array.isArray(filePaths) ? filePaths : [filePaths];
    const uniquePaths = _.uniq(filePathArray);
    this.runBeforeSiteGenerateHooks();
    this.variableProcessor.invalidateCache(); // invalidate internal nunjucks cache for file changes

    return this.regenerateAffectedPages(uniquePaths)
      .then(() => fs.remove(this.tempPath))
      .then(() => this.copyLayouts())
      .catch(error => Site.rejectHandler(error, [this.tempPath, this.outputPath]));
  }

  _rebuildPageBeingViewed(normalizedUrls) {
    const startTime = new Date();
    const normalizedUrlArray = Array.isArray(normalizedUrls) ? normalizedUrls : [normalizedUrls];
    const uniqueUrls = _.uniq(normalizedUrlArray);
    uniqueUrls.forEach(normalizedUrl => logger.info(
      `Building ${normalizedUrl} as some of its dependencies were changed since the last visit`));
    this.runBeforeSiteGenerateHooks();

    /*
     Lazy loading only builds the page being viewed, but the user may be quick enough
     to trigger multiple page builds before the first one has finished building,
     hence we need to take this into account.
     */
    const regeneratePagesBeingViewed = uniqueUrls.map((normalizedUrl) => {
      this._setTimestampVariable();
      const pageToRebuild = this.pages.find(page =>
        FsUtil.removeExtension(page.pageConfig.sourcePath) === normalizedUrl);

      if (!pageToRebuild) {
        return Promise.resolve();
      }

      this.toRebuild.delete(normalizedUrl);
      return pageToRebuild.generate({})
        .then(() => this.writeSiteData())
        .then(() => {
          const endTime = new Date();
          const totalBuildTime = (endTime - startTime) / 1000;
          logger.info(`Lazy website regeneration complete! Total build time: ${totalBuildTime}s`);
        })
        .catch(error => Site.rejectHandler(error, [this.tempPath, this.outputPath]));
    });

    return Promise.all(regeneratePagesBeingViewed)
      .then(() => fs.remove(this.tempPath));
  }

  _rebuildSourceFiles() {
    logger.info('Page added or removed, updating list of site\'s pages...');
    this.variableProcessor.invalidateCache(); // invalidate internal nunjucks cache for file removals

    const removedPageFilePaths = this.updateAddressablePages();
    return this.removeAsset(removedPageFilePaths)
      .then(() => {
        if (this.onePagePath) {
          this.mapAddressablePagesToPages(this.addressablePages || [], this.getFavIconUrl());

          return this.rebuildPageBeingViewed(this.currentPageViewed)
            .then(() => this.lazyBuildAllPagesNotViewed());
        }

        logger.warn('Rebuilding all pages...');
        return this.buildSourceFiles();
      })
      .catch(error => Site.rejectHandler(error, [this.tempPath, this.outputPath]));
  }

  _buildMultipleAssets(filePaths) {
    const filePathArray = Array.isArray(filePaths) ? filePaths : [filePaths];
    const uniquePaths = _.uniq(filePathArray);
    const fileIgnore = ignore().add(this.siteConfig.ignore);
    const fileRelativePaths = uniquePaths.map(filePath => path.relative(this.rootPath, filePath));
    const copyAssets = fileIgnore.filter(fileRelativePaths)
      .map(asset => fs.copy(path.join(this.rootPath, asset), path.join(this.outputPath, asset)));
    return Promise.all(copyAssets)
      .then(() => logger.info('Assets built'));
  }

  _removeMultipleAssets(filePaths) {
    const filePathArray = Array.isArray(filePaths) ? filePaths : [filePaths];
    const uniquePaths = _.uniq(filePathArray);
    const fileRelativePaths = uniquePaths.map(filePath => path.relative(this.rootPath, filePath));
    const filesToRemove = fileRelativePaths.map(
      fileRelativePath => path.join(this.outputPath, fileRelativePath));
    const removeFiles = filesToRemove.map(asset => fs.remove(asset));
    return removeFiles.length === 0
      ? Promise.resolve('')
      : Promise.all(removeFiles)
        .then(() => logger.debug('Assets removed'));
  }

  buildAssets() {
    logger.info('Building assets...');
    const outputFolder = path.relative(this.rootPath, this.outputPath);
    const fileIgnore = ignore().add([...this.siteConfig.ignore, outputFolder]);

    // Scan and copy assets (excluding ignore files).
    return this.listAssets(fileIgnore)
      .then(assets =>
        assets.map(asset =>
          fs.copy(path.join(this.rootPath, asset), path.join(this.outputPath, asset))),
      )
      .then(copyAssets => Promise.all(copyAssets))
      .then(() => logger.info('Assets built'))
      .catch(error => Site.rejectHandler(error, [])); // assets won't affect deletion
  }

  /**
   * Retrieves the correct plugin path for a plugin name, if not in node_modules
   * @param rootPath root of the project
   * @param plugin name of the plugin
   */
  static getPluginPath(rootPath, plugin) {
    // Check in project folder
    const pluginPath = path.join(rootPath, PROJECT_PLUGIN_FOLDER_NAME, `${plugin}.js`);
    if (fs.existsSync(pluginPath)) {
      return pluginPath;
    }

    // Check in src folder
    const markbindPluginPath = path.join(MARKBIND_PLUGIN_DIRECTORY, `${plugin}.js`);
    if (fs.existsSync(markbindPluginPath)) {
      return markbindPluginPath;
    }

    // Check in default folder
    const markbindDefaultPluginPath = path.join(MARKBIND_DEFAULT_PLUGIN_DIRECTORY, `${plugin}.js`);
    if (fs.existsSync(markbindDefaultPluginPath)) {
      return markbindDefaultPluginPath;
    }

    return '';
  }

  /**
   * Finds plugins in the site's default plugin folder
   */
  static findDefaultPlugins() {
    if (!fs.existsSync(MARKBIND_DEFAULT_PLUGIN_DIRECTORY)) {
      return [];
    }
    return walkSync(MARKBIND_DEFAULT_PLUGIN_DIRECTORY, {
      directories: false,
      globs: [`${MARKBIND_PLUGIN_PREFIX}*.js`],
    }).map(file => path.parse(file).name);
  }

  /**
   * Checks if a specified file path is a dependency of a page
   * @param {string} filePath file path to check
   * @returns {boolean} whether the file path is a dependency of any of the site's pages
   */
  isDependencyOfPage(filePath) {
    return this.pages.some(page => page.isDependency(filePath));
  }

  /**
   * Checks if a specified file path satisfies a src or glob in any of the page configurations.
   * @param {string} filePath file path to check
   * @returns {boolean} whether the file path is satisfies any glob
   */
  isFilepathAPage(filePath) {
    const { pages, pagesExclude } = this.siteConfig;
    const relativeFilePath = utils.ensurePosix(path.relative(this.rootPath, filePath));
    const srcesFromPages = _.flatMap(pages.filter(page => page.src),
                                     page => (Array.isArray(page.src) ? page.src : [page.src]));
    if (srcesFromPages.includes(relativeFilePath)) {
      return true;
    }

    const filePathsFromGlobs = _.flatMap(pages.filter(page => page.glob),
                                         page => this.getPageGlobPaths(page, pagesExclude));
    return filePathsFromGlobs.some(fp => fp === relativeFilePath);
  }

  /**
   * Loads a plugin
   * @param plugin name of the plugin
   * @param isDefault whether the plugin is a default plugin
   */
  loadPlugin(plugin, isDefault) {
    try {
      // Check if already loaded
      if (this.plugins[plugin]) {
        return;
      }

      const pluginPath = Site.getPluginPath(this.rootPath, plugin);
      if (isDefault && !pluginPath.startsWith(MARKBIND_DEFAULT_PLUGIN_DIRECTORY)) {
        logger.warn(`Default plugin ${plugin} will be overridden`);
      }

      // eslint-disable-next-line global-require, import/no-dynamic-require
      this.plugins[plugin] = require(pluginPath || plugin);

      if (!this.plugins[plugin].getLinks && !this.plugins[plugin].getScripts) {
        return;
      }

      // For resolving plugin asset source paths later
      this.plugins[plugin]._pluginAbsolutePath = path.dirname(require.resolve(pluginPath || plugin));
      this.plugins[plugin]._pluginAssetOutputPath = path.resolve(this.outputPath,
                                                                 PLUGIN_SITE_ASSET_FOLDER_NAME, plugin);
    } catch (e) {
      logger.warn(`Unable to load plugin ${plugin}, skipping`);
    }
  }

  /**
   * Load all plugins of the site
   */
  collectPlugins() {
    module.paths.push(path.join(this.rootPath, 'node_modules'));

    const defaultPlugins = Site.findDefaultPlugins();

    this.siteConfig.plugins
      .filter(plugin => !_.includes(defaultPlugins, plugin))
      .forEach(plugin => this.loadPlugin(plugin, false));

    const markbindPrefixRegex = new RegExp(`^${MARKBIND_PLUGIN_PREFIX}`);
    defaultPlugins.filter(plugin => !_.get(this.siteConfig,
                                           ['pluginsContext', plugin.replace(markbindPrefixRegex, ''), 'off'],
                                           false))
      .forEach(plugin => this.loadPlugin(plugin, true));
  }

  getFavIconUrl() {
    const { baseUrl, faviconPath } = this.siteConfig;

    if (faviconPath) {
      if (!fs.existsSync(path.join(this.rootPath, faviconPath))) {
        logger.warn(`${faviconPath} does not exist`);
      }
      return url.join('/', baseUrl, faviconPath);
    } else if (fs.existsSync(path.join(this.rootPath, FAVICON_DEFAULT_PATH))) {
      return url.join('/', baseUrl, FAVICON_DEFAULT_PATH);
    }

    return undefined;
  }

  /**
   * Maps an array of addressable pages to an array of Page object
   * @param {Array<Page>} addressablePages
   * @param {String} faviconUrl
   */
  mapAddressablePagesToPages(addressablePages, faviconUrl) {
    this.pages = addressablePages.map(page => this.createPage({
      faviconUrl,
      pageSrc: page.src,
      title: page.title,
      layout: page.layout,
      frontmatter: page.frontmatter,
      searchable: page.searchable !== 'no',
      externalScripts: page.externalScripts,
    }));
  }

  /**
   * Collect the before site generate hooks
   */
  collectPluginSiteHooks() {
    this.pluginsBeforeSiteGenerate = Object.values(this.plugins)
      .filter(plugin => plugin.beforeSiteGenerate)
      .map(plugin => plugin.beforeSiteGenerate);
  }

  /**
   * Collects the special tags of the site's plugins, and injects them into the parsers.
   */
  collectPluginSpecialTags() {
    const tagsToIgnore = new Set();

    Object.values(this.plugins).forEach((plugin) => {
      if (!plugin.getSpecialTags) {
        return;
      }

      plugin.getSpecialTags(plugin.pluginsContext).forEach((tagName) => {
        if (!tagName) {
          return;
        }

        tagsToIgnore.add(tagName.toLowerCase());
      });
    });

    ignoreTags(tagsToIgnore);

    Page.htmlBeautifyOptions = {
      indent_size: 2,
      content_unformatted: ['pre', 'textarea', ...tagsToIgnore],
    };
  }

  /**
   * Executes beforeSiteGenerate hooks from plugins
   */
  runBeforeSiteGenerateHooks() {
    this.pluginsBeforeSiteGenerate.forEach(cb => cb());
  }

  /**
   * Creates the supplied pages' page generation promises at a throttled rate.
   * This is done to avoid pushing too many callbacks into the event loop at once. (#1245)
   * @param {Array<Page>} pages to generate
   * @return {Promise} that resolves once all pages have generated
   */
  static generatePagesThrottled(pages) {
    const builtFiles = {};

    const progressBar = new ProgressBar(`[:bar] :current / ${pages.length} pages built`,
                                        { total: pages.length });
    progressBar.render();

    return new Promise((resolve, reject) => {
      let numPagesGenerated = 0;

      // Map pages into array of callbacks for delayed execution
      const pageGenerationQueue = pages.map(page => () => page.generate(builtFiles)
        .then(() => {
          progressBar.tick();
          numPagesGenerated += 1;

          if (pageGenerationQueue.length) {
            pageGenerationQueue.pop()();
          } else if (numPagesGenerated === pages.length) {
            resolve();
          }
        })
        .catch((err) => {
          logger.error(err);
          reject(new Error(`Error while generating ${page.sourcePath}`));
        }));

      /*
       Take the first MAX_CONCURRENT_PAGE_GENERATION_PROMISES callbacks and execute them.
       Whenever a page generation callback resolves,
       it pops the next unprocessed callback off pageGenerationQueue and executes it.
       */
      pageGenerationQueue.splice(0, MAX_CONCURRENT_PAGE_GENERATION_PROMISES)
        .forEach(generatePage => generatePage());
    });
  }

  /**
   * Renders all pages specified in site configuration file to the output folder
   */
  generatePages() {
    // Run MarkBind include and render on each source file.
    // Render the final rendered page to the output folder.
    const addressablePages = this.addressablePages || [];

    const faviconUrl = this.getFavIconUrl();

    this._setTimestampVariable();
    this.mapAddressablePagesToPages(addressablePages, faviconUrl);

    return Site.generatePagesThrottled(this.pages);
  }

  /**
   * Renders only the starting page for lazy loading to the output folder.
   */
  generateLandingPage() {
    const addressablePages = this.addressablePages || [];
    const faviconUrl = this.getFavIconUrl();

    this._setTimestampVariable();
    this.mapAddressablePagesToPages(addressablePages, faviconUrl);

    const landingPage = this.pages.find(page => page.pageConfig.src === this.onePagePath);
    if (!landingPage) {
      return Promise.reject(new Error(`${this.onePagePath} is not specified in the site configuration.`));
    }

    return landingPage.generate({});
  }

  regenerateAffectedPages(filePaths) {
    const startTime = new Date();

    const shouldRebuildAllPages = this.collectUserDefinedVariablesMapIfNeeded(filePaths) || this.forceReload;
    if (shouldRebuildAllPages) {
      logger.warn('Rebuilding all pages as variables file was changed, or the --force-reload flag was set');
    }
    this._setTimestampVariable();
    const pagesToRegenerate = this.pages.filter((page) => {
      const doFilePathsHaveSourceFiles = filePaths.some(filePath => page.isDependency(filePath));

      if (shouldRebuildAllPages || doFilePathsHaveSourceFiles) {
        if (this.onePagePath) {
          const normalizedSource = FsUtil.removeExtension(page.pageConfig.sourcePath);
          const isPageBeingViewed = normalizedSource === this.currentPageViewed;

          if (!isPageBeingViewed) {
            this.toRebuild.add(normalizedSource);
            return false;
          }
        }

        return true;
      }

      return false;
    });
    if (!pagesToRegenerate.length) {
      logger.info('No pages needed to be rebuilt');
      return Promise.resolve();
    }

    logger.info(`Rebuilding ${pagesToRegenerate.length} pages`);

    return Site.generatePagesThrottled(pagesToRegenerate)
      .then(() => this.writeSiteData())
      .then(() => logger.info('Pages rebuilt'))
      .then(() => {
        const endTime = new Date();
        const totalBuildTime = (endTime - startTime) / 1000;
        logger.info(`Website regeneration complete! Total build time: ${totalBuildTime}s`);
        if (!this.onePagePath && totalBuildTime > LAZY_LOADING_REBUILD_TIME_RECOMMENDATION_LIMIT) {
          logger.info('Your pages took quite a while to rebuild...'
              + 'Have you considered using markbind serve -o when writing content to speed things up?');
        }
      })
      .catch(error => Site.rejectHandler(error, []));
  }

  /**
   * Copies Font Awesome assets to the assets folder
   */
  copyFontAwesomeAsset() {
    const faRootSrcPath = path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json'));
    const faCssSrcPath = path.join(faRootSrcPath, 'css', 'all.min.css');
    const faCssDestPath = path.join(this.siteAssetsDestPath, 'fontawesome', 'css', 'all.min.css');
    const faFontsSrcPath = path.join(faRootSrcPath, 'webfonts');
    const faFontsDestPath = path.join(this.siteAssetsDestPath, 'fontawesome', 'webfonts');

    return fs.copy(faCssSrcPath, faCssDestPath).then(() => fs.copy(faFontsSrcPath, faFontsDestPath));
  }

  /**
   * Copies Octicon assets to the assets folder
   */
  copyOcticonsAsset() {
    const octiconsCssSrcPath = require.resolve('@primer/octicons/build/build.css');
    const octiconsCssDestPath = path.join(this.siteAssetsDestPath, 'css', 'octicons.css');

    return fs.copy(octiconsCssSrcPath, octiconsCssDestPath);
  }

  /**
   * Copies core-web bundles and external assets to the assets output folder
   */
  copyCoreWebAsset() {
    const coreWebRootPath = path.dirname(require.resolve('@markbind/core-web/package.json'));
    const coreWebAssetPath = path.join(coreWebRootPath, 'asset');
    fs.copySync(coreWebAssetPath, this.siteAssetsDestPath);

    const dirsToCopy = ['fonts'];
    const filesToCopy = [
      'js/markbind.min.js',
      'css/markbind.min.css',
    ];

    const copyAllFiles = filesToCopy.map((file) => {
      const srcPath = path.join(coreWebRootPath, 'dist', file);
      const destPath = path.join(this.siteAssetsDestPath, file);
      return fs.copy(srcPath, destPath);
    });

    const copyFontsDir = dirsToCopy.map((dir) => {
      const srcPath = path.join(coreWebRootPath, 'dist', dir);
      const destPath = path.join(this.siteAssetsDestPath, 'css', dir);
      return fs.copy(srcPath, destPath);
    });

    return Promise.all([...copyAllFiles, ...copyFontsDir]);
  }

  /**
   * Copies bootswatch theme to the assets folder if a valid theme is specified
   */
  copyBootswatchTheme() {
    const { theme } = this.siteConfig;
    if (!theme || !_.has(SUPPORTED_THEMES_PATHS, theme)) {
      return _.noop;
    }

    const themeSrcPath = SUPPORTED_THEMES_PATHS[theme];
    const themeDestPath = path.join(this.siteAssetsDestPath, 'css', 'bootstrap.min.css');

    return fs.copy(themeSrcPath, themeDestPath);
  }

  /**
   * Copies layouts to the assets folder
   */
  copyLayouts() {
    const siteLayoutPath = path.join(this.rootPath, LAYOUT_FOLDER_PATH);
    const layoutsDestPath = path.join(this.siteAssetsDestPath, LAYOUT_SITE_FOLDER_NAME);
    if (!fs.existsSync(siteLayoutPath)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const files = walkSync(siteLayoutPath);
      resolve(files);
    }).then((files) => {
      if (!files) {
        return Promise.resolve();
      }
      const filteredFiles = files.filter(file => _.includes(file, '.') && !_.includes(file, '.md'));
      const copyAll = Promise.all(filteredFiles.map(file =>
        fs.copy(path.join(siteLayoutPath, file), path.join(layoutsDestPath, file))));
      return copyAll.then(() => Promise.resolve());
    });
  }

  /**
   * Writes the site data to siteData.json
   */
  writeSiteData() {
    const siteDataPath = path.join(this.outputPath, SITE_DATA_NAME);
    const siteData = {
      enableSearch: this.siteConfig.enableSearch,
      pages: this.pages.filter(page => page.pageConfig.searchable && page.headings)
        .map(page => ({
          src: page.pageConfig.src,
          title: page.title,
          headings: page.headings,
          headingKeywords: page.keywords,
        })),
    };

    return fs.outputJson(siteDataPath, siteData, { spaces: 2 })
      .then(() => logger.info('Site data built'))
      .catch(error => Site.rejectHandler(error, [this.tempPath, this.outputPath]));
  }

  deploy(travisTokenVar) {
    const defaultDeployConfig = {
      branch: 'gh-pages',
      message: 'Site Update.',
      repo: '',
      remote: 'origin',
    };
    process.env.NODE_DEBUG = 'gh-pages';
    return new Promise((resolve, reject) => {
      const publish = Promise.promisify(ghpages.publish);
      this.readSiteConfig()
        .then(() => {
          const basePath = this.siteConfig.deploy.baseDir || this.outputPath;
          if (!fs.existsSync(basePath)) {
            reject(new Error(
              'The site directory does not exist. Please build the site first before deploy.'));
            return undefined;
          }
          const options = {};
          options.branch = this.siteConfig.deploy.branch || defaultDeployConfig.branch;
          options.message = this.siteConfig.deploy.message || defaultDeployConfig.message;
          options.repo = this.siteConfig.deploy.repo || defaultDeployConfig.repo;

          if (travisTokenVar) {
            if (!process.env.TRAVIS) {
              reject(new Error('-t/--travis should only be run in Travis CI.'));
              return undefined;
            }
            // eslint-disable-next-line no-param-reassign
            travisTokenVar = _.isBoolean(travisTokenVar) ? 'GITHUB_TOKEN' : travisTokenVar;
            if (!process.env[travisTokenVar]) {
              reject(new Error(`The environment variable ${travisTokenVar} does not exist.`));
              return undefined;
            }

            const githubToken = process.env[travisTokenVar];
            let repoSlug = process.env.TRAVIS_REPO_SLUG;
            if (options.repo) {
              // Extract repo slug from user-specified repo URL so that we can include the access token
              const repoSlugRegex = /github\.com[:/]([\w-]+\/[\w-.]+)\.git$/;
              const repoSlugMatch = repoSlugRegex.exec(options.repo);
              if (!repoSlugMatch) {
                reject(new Error('-t/--travis expects a GitHub repository.\n'
                  + `The specified repository ${options.repo} is not valid.`));
                return undefined;
              }
              [, repoSlug] = repoSlugMatch;
            }
            options.repo = `https://${githubToken}@github.com/${repoSlug}.git`;
            options.user = {
              name: 'Deployment Bot',
              email: 'deploy@travis-ci.org',
            };
          }

          publish(basePath, options);
          return options;
        })
        .then((options) => {
          const git = simpleGit({ baseDir: process.cwd() });
          options.remote = defaultDeployConfig.remote;
          return Site.getDeploymentUrl(git, options);
        })
        .then(depUrl => resolve(depUrl))
        .catch(reject);
    });
  }

  /**
   * Gets the deployed website's url, returning null if there was an error retrieving it.
   */
  static getDeploymentUrl(git, options) {
    const HTTPS_PREAMBLE = 'https://';
    const SSH_PREAMBLE = 'git@github.com:';
    const GITHUB_IO_PART = 'github.io';

    // https://<name|org name>.github.io/<repo name>/
    function constructGhPagesUrl(remoteUrl) {
      if (!remoteUrl) {
        return null;
      }
      const parts = remoteUrl.split('/');
      if (remoteUrl.startsWith(HTTPS_PREAMBLE)) {
        // https://github.com/<name|org>/<repo>.git (HTTPS)
        const repoNameWithExt = parts[parts.length - 1];
        const repoName = repoNameWithExt.substring(0, repoNameWithExt.lastIndexOf('.'));
        const name = parts[parts.length - 2].toLowerCase();
        return `https://${name}.${GITHUB_IO_PART}/${repoName}`;
      } else if (remoteUrl.startsWith(SSH_PREAMBLE)) {
        // git@github.com:<name|org>/<repo>.git (SSH)
        const repoNameWithExt = parts[parts.length - 1];
        const repoName = repoNameWithExt.substring(0, repoNameWithExt.lastIndexOf('.'));
        const name = parts[0].substring(SSH_PREAMBLE.length);
        return `https://${name}.${GITHUB_IO_PART}/${repoName}`;
      }
      return null;
    }

    const { remote, branch, repo } = options;
    const cnamePromise = gitUtil.getRemoteBranchFile(git, 'blob', remote, branch, 'CNAME');
    const remoteUrlPromise = gitUtil.getRemoteUrl(git, remote);
    const promises = [cnamePromise, remoteUrlPromise];

    return Promise.all(promises)
      .then((results) => {
        const cname = results[0];
        const remoteUrl = results[1];
        if (cname) {
          return cname.trim();
        } else if (repo) {
          return constructGhPagesUrl(repo);
        }
        return constructGhPagesUrl(remoteUrl.trim());
      })
      .catch((err) => {
        logger.error(err);
        return null;
      });
  }

  _setTimestampVariable() {
    const options = {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: this.siteConfig.timeZone,
      timeZoneName: 'short',
    };
    const time = new Date().toLocaleTimeString(this.siteConfig.locale, options);
    this.variableProcessor.addUserDefinedVariableForAllSites('timestamp', time);
    return Promise.resolve();
  }
}

/**
 * Below are functions that are not compatible with the ES6 class syntax.
 */

/**
 * Build/copy assets that are specified in filePaths
 * @param filePaths a single path or an array of paths corresponding to the assets to build
 */
Site.prototype.buildAsset = delay(Site.prototype._buildMultipleAssets, 1000);

Site.prototype.rebuildPageBeingViewed = delay(Site.prototype._rebuildPageBeingViewed, 1000);

/**
 * Rebuild pages that are affected by changes in filePaths
 * @param filePaths a single path or an array of paths corresponding to the files that have changed
 */
Site.prototype.rebuildAffectedSourceFiles = delay(Site.prototype._rebuildAffectedSourceFiles, 1000);

/**
 * Rebuild all pages
 * @param filePaths a single path or an array of paths corresponding to the files that have changed
 */
Site.prototype.rebuildSourceFiles = delay(Site.prototype._rebuildSourceFiles, 1000);

/**
 * Remove assets that are specified in filePaths
 * @param filePaths a single path or an array of paths corresponding to the assets to remove
 */
Site.prototype.removeAsset = delay(Site.prototype._removeMultipleAssets, 1000);

module.exports = Site;
