/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2024 Toha <tohenk@yahoo.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const fs = require('fs');
const path = require('path');
const Work = require('@ntlab/work/work');
const Queue = require('@ntlab/work/queue');
const { Sequelize, Model, BelongsToAssociation } = require('@sequelize/core');
const debug = require('debug')('sequelize:manager');

/**
 * A callback to extend Sequelize model.
 *
 * Example:
 *
 * ```
 * function modelInstanceFn(model) {
 *     return {
 *          toString: function() {
 *              return this.name;
 *          }
 *     }
 * }
 * ```
 *
 * @callback extensionCallback
 * @param {Model} model Sequelize model
 * @returns {object}
 */

/**
 * Sequelize model manager.
 */
class Manager {

    config = {}

    /**
     * Constructor.
     *
     * The mandatory constructor options is `modeldir`. Based on this directory, certain folders
     * will be searched and used:
     *
     * * `extension`: contains Sequelize model attribuutes extension
     * * `hook`: contains `lifecycle` handler
     * * `data`: contains `lifecycle.json` and `tostring.json`
     * * `extend`: contains model static and instance extension
     * * `addon`: contains addons handler
     * * `fixture`: contains model fixture data
     *
     * @param {object} config Contructor options with the following keys:
     *   * `modelStore`:   The object to store the reference to models
     *   * `modeldir`:     The path which contains models will be looked for
     *   * `extensiondir`: The extension directory, will use `modeldir/extension` if not specified
     *   * `hookdir`:      The hook directory, will use `modeldir/hook` if not specified
     *   * `datadir`:      The data directory, will use `modeldir/data` if not specified
     *   * `extenddir`:    The extend directory, will use `modeldir/extend` if not specified
     *   * `addondir`:     The addon directory, will use `modeldir/addon` if not specified
     *   * `fixturedir`:   The fixture directory, will use `modeldir/fixture` if not specified
     * @param {string} config.modeldir
     * @param {string|undefined} config.fixturedir
     */
    constructor(config) {
        if (!fs.existsSync(config.modeldir)) {
            throw new Error('Contructor options modeldir is mandatory and the path must exists!');
        }
        this.config = config;
        this.modelStore = config.modelStore;
        this.modelDir = config.modeldir;
        this.extensionDir = config.extensiondir || path.join(this.modelDir, 'extension');
        this.fixtureDir = config.fixturedir || path.join(this.modelDir, 'fixture');
        this.hookDir = config.hookdir || path.join(this.modelDir, 'hook');
        this.dataDir = config.datadir || path.join(this.modelDir, 'data');
        this.extendDir = config.extenddir || path.join(this.modelDir, 'extend');
        this.addonDir = config.addondir || path.join(this.modelDir, 'addon');
    }

    /**
     * Get Sequelize instance.
     *
     * @returns {Sequelize}
     */
    getSequelize() {
        return this.db;
    }

    /**
     * Initialize Sequelize.
     *
     * @param {object} options Sequelize contructor options
     * @returns {Promise}
     */
    init(options) {
        this.db = new Sequelize(options);
        if (Array.isArray(this.config.extensions) && this.config.extensions.length) {
            this.db.hooks.addListener('afterPoolAcquire', (connection, options) => {
                if (connection.extensions === undefined) {
                    connection.extensions = [];
                }
                this.config.extensions.forEach(extension => {
                    if (connection.extensions.indexOf(extension) < 0) {
                        connection.loadExtension(extension);
                        connection.extensions.push(extension);
                        debug(`Extension ${extension} loaded`);
                    }
                });
            });
        }
        return Work.works([
            [w => this.loadLifecycles()],
            [w => this.loadAddons()],
            [w => this.loadModels()],
            [w => this.associates()],
        ]);
    }

    /**
     * Connect to database.
     *
     * @returns {Promise}
     */
    connectDatabase() {
        return Work.works([
            [w => this.db.authenticate()],
            [w => this.config.onconnect(), w => typeof this.config.onconnect === 'function'],
        ]);
    }

    /**
     * Load addons.
     *
     * @returns {Promise}
     */
    loadAddons() {
        return new Promise((resolve, reject) => {
            this.addons = [];
            if (fs.existsSync(this.addonDir)) {
                fs.readdir(this.addonDir, (err, files) => {
                    if (err) {
                        return reject(err);
                    }
                    files.forEach(file => {
                        if (file.endsWith('.js')) {
                            const addon = require(path.join(this.addonDir, file.substring(0, file.length - 3)));
                            this.addons.push(addon);
                            debug(`Found addon ${addon.name}`);
                        }
                    });
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    /**
     * Load all models.
     *
     * @returns {Promise}
     */
    loadModels() {
        return new Promise((resolve, reject) => {
            this.fixtures = [];
            this.stringable = {};
            fs.readdir(this.modelDir, (err, files) => {
                if (err) {
                    return reject(err);
                }
                const stringableFile = path.join(this.dataDir, 'tostring.json');
                if (fs.existsSync(stringableFile)) {
                    this.stringable = JSON.parse(fs.readFileSync(stringableFile));
                }
                files.forEach(file => {
                    if (file.endsWith('.js')) {
                        const modelName = file.substring(0, file.length - 3);
                        const features = {};
                        let attributes, options;
                        // load attribute extension
                        if (fs.existsSync(path.join(this.extensionDir, file))) {
                            attributes = require(path.join(this.extensionDir, modelName))(this.db);
                            features.extension = true;
                        }
                        // apply lifecycle handler
                        if (this.lifeCycles[modelName]) {
                            options = options => {
                                this.lifeCycles[modelName].forEach(lifecycle => {
                                    lifecycle.handle(options);
                                });
                                return options;
                            }
                            features.lifecycle = true;
                        }
                        const model = require(path.join(this.modelDir, modelName))(this.db, attributes, options);
                        // handle model extension
                        if (fs.existsSync(path.join(this.extendDir, file))) {
                            const ModelExtend = require(path.join(this.extendDir, modelName));
                            Manager.extend(model, ModelExtend);
                            features.extended = true;
                        }
                        // handle toString()
                        if (this.stringable[modelName]) {
                            model.stringable = this.stringable[modelName];
                            features.stringable = true;
                        }
                        // register addons
                        if (Array.isArray(this.addons)) {
                            this.addons.forEach(addon => {
                                Manager.extend(model, addon);
                            });
                            features.addons = true;
                        }
                        // check if fixture exist
                        const fixture = path.join(this.fixtureDir, modelName + '.json');
                        if (fs.existsSync(fixture)) {
                            this.fixtures.push({model: model, fixture: fixture});
                            features.fixture = true;
                        }
                        // add model reference
                        model.db = this;
                        this[modelName] = model;
                        if (typeof this.modelStore === 'object') {
                            this.modelStore[modelName] = model;
                        }
                        // define model as property
                        if (this.db.models[modelName] === undefined) {
                            Object.defineProperty(this.db.models, modelName, {value: model, writable: false});
                        }
                        debug(`Found model ${model.name} with features [${Object.keys(features).join(', ')}]`);
                    }
                });
                resolve();
            });
        });
    }

    /**
     * Associates loaded models.
     *
     * @returns {Promise}
     */
    associates() {
        return new Promise((resolve, reject) => {
            for (const model of this.db.models.getModelsTopoSortedByForeignKey()) {
                if (typeof model.associate === 'function') {
                    model.associate();
                }
            }
            resolve();
        });
    }

    /**
     * Load lifecycles data for models.
     *
     * @returns {Promise}
     */
    loadLifecycles() {
        return new Promise((resolve, reject) => {
            this.lifeCycles = {};
            const lifecycleFile = path.join(this.dataDir, 'lifecycle.json');
            if (fs.existsSync(lifecycleFile)) {
                const lifeCycles = JSON.parse(fs.readFileSync(lifecycleFile));
                Object.keys(lifeCycles).forEach(lifecycle => {
                    const lifecycleHandler = path.join(this.hookDir, lifecycle + '.js');
                    if (fs.existsSync(lifecycleHandler)) {
                        const handler = require(path.join(this.hookDir, lifecycle));
                        lifeCycles[lifecycle].forEach(m => {
                            if (!this.lifeCycles[m]) {
                                this.lifeCycles[m] = [];
                            }
                            this.lifeCycles[m].push(handler);
                        });
                    }
                });
            }
            resolve();
        });
    }

    /**
     * Populate model fixtures.
     *
     * @returns {Promise}
     */
    loadFixtures() {
        return new Promise((resolve, reject) => {
            const q = new Queue(this.fixtures, f => {
                Work.works([
                    [w => f.model.count()],
                    [w => Promise.resolve(fs.existsSync(f.fixture)), w => w.getRes(0) === 0],
                    [w => Promise.resolve(JSON.parse(fs.readFileSync(f.fixture))), w => w.getRes(0) === 0 && w.getRes(1)],
                    [w => this.populateData(f.model, w.getRes(2)), w => w.getRes(0) === 0 && w.getRes(1)],
                ])
                .then(() => q.next())
                .catch(err => {
                    console.error(err);
                    q.next();
                });
            });
            q.once('done', () => resolve());
        });
    }

    /**
     * Populate fixture for model.
     *
     * @param {Model} model Sequelize model
     * @param {object} values Row values
     * @returns {Promise}
     */
    populateData(model, values) {
        return new Promise((resolve, reject) => {
            let n = values.length;
            let i = 0, progress = 0;
            const q = new Queue(values, value => {
                const p = Math.floor(++i / n * 100);
                if (p > progress) {
                    progress = p;
                    debug(`Populate data ${model.name} (${progress}%)`);
                    if (typeof this.config.onpopulate === 'function') {
                        this.config.onpopulate(model, progress);
                    }
                }
                model.create(value)
                    .then(() => q.next())
                    .catch(err => reject(err));
            });
            q.once('done', () => resolve());
        });
    }

    /**
     * Synchronize models.
     *
     * @param {boolean} force Force synchronization
     * @returns {Promise}
     */
    syncModels(force = false) {
        return new Promise((resolve, reject) => {
            const q = new Queue(this.db.models.getModelsTopoSortedByForeignKey(), model => {
                this.syncModel(model, force)
                    .then(() => q.next())
                    .catch(err => reject(err));
            });
            q.once('done', () => resolve());
        });
    }

    /**
     * Synchronize model.
     *
     * @param {Model} model Sequelize model
     * @param {*} force Force synchronization
     * @returns {Promise}
     */
    syncModel(model, force = false) {
        if (!this.syncs) {
            this.syncs = [];
        }
        if (this.syncs.indexOf(model) >= 0) {
            return Promise.resolve();
        } else {
            return Work.works([
                [w => Promise.resolve(this.getModelReferences(model))],
                [w => new Promise((resolve, reject) => {
                    const q = new Queue(w.res, m => {
                        this.syncModel(this.db.models[m], force)
                            .then(() => q.next())
                            .catch(err => reject(err));
                    });
                    q.once('done', () => resolve());
                })],
                [w => model.sync({force: force})],
                [w => Promise.resolve(this.syncs.push(model))],
            ]);
        }
    }

    /**
     * Get model references.
     *
     * @param {Model} model Sequelize model
     * @returns {string[]}
     */
    getModelReferences(model) {
        const ref = [];
        const attributes = model.getAttributes();
        Object.keys(attributes).forEach(a => {
            const attr = attributes[a];
            if (attr.references && attr.references.tableName) {
                let m;
                // model is a Model
                if (attr.references.tableName instanceof Model) {
                    m = attr.references.tableName;
                }
                // model is a tablename reference
                if (typeof attr.references.tableName === 'string') {
                    m = this.getModelFromTable(attr.references.tableName);
                }
                if (m && ref.indexOf(m.name) < 0) {
                    ref.push(m.name);
                }
            }
        });
        return ref;
    }

    /**
     * Get model from table name.
     *
     * @param {string} table Table name
     * @returns {Model}
     */
    getModelFromTable(table) {
        for (const model of this.db.models.getModelsTopoSortedByForeignKey()) {
            if (model.table.tableName === table) {
                return model;
            }
        }
    }

    /**
     * Create model instance.
     *
     * @param {Model} model Sequelize model
     * @param {object|Array} values Model attributes values
     * @returns {object}
     */
    createInstance(model, values) {
        const res = model.build({});
        this.setValues(res, values);
        return res;
    }

    /**
     * Set model instance values.
     *
     * @param {object} model Model instance
     * @param {object} values Model values 
     * @param {function} callback 
     */
    setValues(model, values, callback = null) {
        const fields = model.constructor.getAttributes();
        const fieldNames = Object.keys(fields);
        // convert object to array
        if (typeof values === 'object' && !Array.isArray(values)) {
            const v = [];
            Object.keys(values).forEach(k => {
                v.push([k, values[k]]);
            });
            values = v;
        }
        if (values.length) {
            values.forEach(value => {
                if (fieldNames.indexOf(value[0]) >= 0) {
                    model.set(value[0], value[1]);
                } else if (typeof callback === 'function') {
                    callback(value[0], value[1]);
                }
            });
        }
    }

    /**
     * Get model instance values.
     *
     * @param {string} tableName Table name
     * @param {object|null} query Where conditions
     * @param {boolean|null} raw Returns raw value
     * @param {function} optionsCallback A callback to call to transform options for findAll()
     * @returns {object}
     */
    async getValues(tableName, query = null, raw = null, optionsCallback = null) {
        const res = {};
        if (typeof raw === 'function') {
            optionsCallback = raw;
            raw = null;
        }
        if (tableName) {
            const model = this.getModelFromTable(tableName);
            if (model) {
                let keyfield;
                const fields = model.getAttributes();
                Object.keys(fields).forEach(field => {
                    if (fields[field].primaryKey) {
                        keyfield = field;
                        return true;
                    }
                });
                if (keyfield) {
                    const options = query ? {where: query} : {};
                    const includes = this.getIncludes(model);
                    if (includes.length) {
                        options.include = includes;
                    }
                    if (typeof optionsCallback === 'function') {
                        optionsCallback(options);
                    }
                    const values = await model.findAll(options);
                    values.forEach(value => {
                        if (raw) {
                            res[value[keyfield]] = value;
                        } else {
                            res[value[keyfield]] = value.toString();
                        }
                    });
                }
            }
        }
        return res;
    }

    /**
     * Get model includes.
     *
     * @param {Model} model Sequelize model
     * @param {BelongsToAssociation[]} belongs BelongsTo association
     */
    getIncludes(model, belongs = []) {
        const res = [];
        for (const a in model.associations) {
            const association = model.associations[a];
            if (association instanceof BelongsToAssociation) {
                const incl = {model: association.target, as: a};
                if (Array.isArray(belongs) && belongs.length) {
                    for (let i = 0; i < belongs.length; i++) {
                        let bm, bb = [];
                        if (Array.isArray(belongs[i])) {
                            bm = belongs[i][0];
                            if (belongs[i].length > 1 && Array.isArray(belongs[i][1])) {
                                bb = belongs[i][1];
                            }
                        } else {
                            bm = belongs[i];
                        }
                        if (bm.name !== incl.model.name) {
                            continue;
                        }
                        const bincl = this.getIncludes(bm, bb);
                        if (bincl.length) {
                            incl.include = bincl;
                        }
                    }
                }
                res.push(incl);
            }
        }
        return res;
    }

    /**
     * Extend Sequelize model.
     *
     * An extension data can have the following functions:
     *
     * * `getAttributes()`: returns objects to be applied as model attributes
     * * `getFunctions()`: returns functions to be applied as model static function
     * * `getInstanceFunctions()`: returns functions to be applied as model instance function
     *
     * @param {Model} model Sequelize model
     * @param {object} data Extension
     * @param {extensionCallback|undefined} data.getAttributes
     * @param {extensionCallback|undefined} data.getFunctions
     * @param {extensionCallback|undefined} data.getInstanceFunctions
     */
    static extend(model, data) {
        let count = 0;
        if (typeof data.getAttributes === 'function') {
            const attributes = data.getAttributes(model);
            Object.keys(attributes).forEach(attr => {
                Object.assign(model.attributes, attributes[attr]);
            });
            count++;
        }
        if (typeof data.getFunctions === 'function') {
            const staticFn = data.getFunctions(model);
            Object.keys(staticFn).forEach(fn => {
                model[fn] = staticFn[fn];
            });
            count++;
        }
        if (typeof data.getInstanceFunctions === 'function') {
            const instanceFn = data.getInstanceFunctions(model);
            Object.keys(instanceFn).forEach(fn => {
                if (typeof model.prototype[fn] !== 'undefined') {
                    model.prototype['__' + fn] = model.prototype[fn];
                }
                model.prototype[fn] = instanceFn[fn];
            });
            count++;
        }
        if (count === 0) {
            console.warn(`Not extending ${model.name}, may be missing getAttributes(), getFunctions(), or getInstanceFunctions()`);
        }
    }
}

module.exports = Manager;