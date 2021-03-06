/**
 *  All public interfaces are contained here.  They either fan out to query.js, update.js or db.js in the
 *  individual database directories.  Three kinds of interfaces are available
 *
 *  - Object Intefaces are methods added to objects instantiated from PersistObjectTemplate contexts
 *
 *  - Template interfaces are methods added to templates instantiated from PersistObjectTemplate
 *
 *  - ObjectTemplate intefaces are session level interfaces
 *
 */

module.exports = function (PersistObjectTemplate, baseClassForPersist) {

    var Promise = require('bluebird');
    var _ = require('underscore');

    /**
     * PUBLIC INTERFACE FOR OBJECTS
     */

    PersistObjectTemplate._injectIntoObject = function (object)
    {
        baseClassForPersist._injectIntoObject(object);
        var self = this;

        object.persistSave = function (txn)
        {
            PersistObjectTemplate.debug("persistSave " + object.__template__.__name__ + " " + object.__id__, 'api');
            var dbType = PersistObjectTemplate.getDB(PersistObjectTemplate.getDBAlias(object.__template__.__collection__)).type;
            return dbType == PersistObjectTemplate.DB_Mongo ?
                PersistObjectTemplate.persistSaveMongo(object, undefined, undefined, undefined, txn)
                    .then (function (obj) {
                        if (txn)
                            PersistObjectTemplate.saved(obj ,txn);
                        return Promise.resolve(obj._id.toString())
                    })
                : PersistObjectTemplate.persistSaveKnex(object, txn)
                .then (function (obj) {
                    if (txn)
                        PersistObjectTemplate.saved(obj ,txn);
                    return Promise.resolve(obj._id.toString());
                });
        };

        object.persistTouch = function (txn)
        {
            PersistObjectTemplate.debug("persistTouch " + object.__template__.__name__ + " " + object.__id__, 'api');
            var dbType = PersistObjectTemplate.getDB(PersistObjectTemplate.getDBAlias(object.__template__.__collection__)).type;
            return dbType == PersistObjectTemplate.DB_Mongo ?
                PersistObjectTemplate.persistSaveMongo(object, undefined, undefined, undefined, txn)
                : PersistObjectTemplate.persistTouchKnex(object, txn);
        };

        object.persistDelete = function (txn) {
            PersistObjectTemplate.debug("persistTouch " + object.__template__.__name__ + " " + object.__id__, 'api');
            if (txn) {
                delete txn.dirtyObjects[this.__id__];
            }
            return this.__template__.deleteFromPersistWithId(this._id, txn)
        };

        object.setDirty = function (txn, onlyIfChanged, cascade) {
            PersistObjectTemplate.setDirty(this, txn, onlyIfChanged, !cascade);
        };
        object.cascadeSave = function (txn) {
            PersistObjectTemplate.setDirty(this, txn || PersistObjectTemplate.currentTransaction, true, false);
        };
        object.isDirty = function () {
            return this['__dirty__'] ? true : false
        };
        object.isStale = function () {
            var dbType = PersistObjectTemplate.getDB(PersistObjectTemplate.getDBAlias(this.__template__.__collection__)).type;
            return this.__template__.countFromPersistWithQuery(
                {_id: (dbType == PersistObjectTemplate.DB_Mongo) ? PersistObjectTemplate.ObjectID(this._id.toString()) : this._id,
                    __version__: this.__version__}).then(function(count) {
                return !count
            });
        };

        object.fetchProperty = function (prop, cascade, queryOptions, isTransient, idMap)
        {
            PersistObjectTemplate.debug("fetchProperty " + object.__template__.__name__ + " " + object._id, 'api');
            idMap = idMap || {};
            var properties = {}
            var objectProperties = this.__template__.getProperties();
            properties[prop] = objectProperties[prop];
            if (queryOptions)
                properties[prop].queryOptions = queryOptions;
            cascadeTop = {};
            cascadeTop[prop] = cascade || true;

            var dbType = PersistObjectTemplate.getDB(PersistObjectTemplate.getDBAlias(object.__template__.__collection__)).type;
            return dbType == PersistObjectTemplate.DB_Mongo ?
                self.getTemplateFromMongoPOJO(this, this.__template__, null, null, idMap, cascadeTop, this, properties, isTransient) :
                self.getTemplateFromKnexPOJO(this, this.__template__, null, idMap, cascadeTop, isTransient, null, this, properties);

        };

        object.fetch = function (cascade, isTransient, idMap)
        {
            PersistObjectTemplate.debug("fetch " + object.__template__.__name__ + " " + object._id, 'api');
            idMap = idMap || {};

            var properties = {}
            var objectProperties = this.__template__.getProperties();
            for (var prop in cascade)
                properties[prop] = objectProperties[prop];
            var dbType = PersistObjectTemplate.getDB(PersistObjectTemplate.getDBAlias(object.__template__.__collection__)).type;
            var previousDirtyTracking = PersistObjectTemplate.__changeTracking__;
            PersistObjectTemplate.__changeTracking__ = false;
            return (dbType == PersistObjectTemplate.DB_Mongo ?
                self.getTemplateFromMongoPOJO(this, this.__template__, null, null, idMap, cascade, this, properties, isTransient) :
                self.getTemplateFromKnexPOJO(this, this.__template__, null, idMap, cascade, isTransient, null, this, properties))
                .then(function (res) {
                    return res;
                })
                .finally(function () {
                    PersistObjectTemplate.__changeTracking__ = previousDirtyTracking;
                });


        };
        object.refresh = function ()
        {
            PersistObjectTemplate.debug("refresh " + object.__template__.__name__ + " " + object._id, 'api');
            return this.__template__.getFromPersistWithId(object._id, null, null, null, true)
        };
    };
    PersistObjectTemplate.getPersistorProps = function () {
        persistorProps = {};
        _.each(PersistObjectTemplate.__dictionary__, processTemplate);
        return persistorProps;

        function processTemplate(template) {

            var props = template.getProperties();
            _.each(props, processDefineProperty);

            function processDefineProperty(defineProperty, prop) {
                if (prop.match(/Persistor$/) && prop.substr(0, 2) != '__') {
                    persistorProps[template.__name__] = persistorProps[template.__name__] || {}
                    persistorProps[template.__name__][prop.replace(/Persistor$/, '')] = 1;
                }
            }
        }
    }
    /**
     * PUBLIC INTERFACE FOR TEMPLATES
     */
    PersistObjectTemplate._injectIntoTemplate = function (template)
    {
        if(!this.schemaVerified)
            this._verifySchema();
        this.schemaVerified = true;

        // Process subclasses that didn't have schema entries
        var parent = template.__parent__;
        while(!template.__schema__ && parent)
            if (parent.__schema__) {
                template.__schema__ = parent.__schema__;
                template.__collection__ = parent.__collection__;
                template.__table__ = template.__schema__.table ? template.__schema__.table :parent.__table__;
                template.__topTemplate = parent.__topTemplate__;
                parent = null;
            } else
                parent = parent.__parent__;

        // Process subsets
        if (template.__schema__ && template.__schema__.subsetOf) {
            var mainTemplate = this.__dictionary__[template.__schema__.subsetOf];
            if (!mainTemplate)
                throw new Error("Reference to subsetOf " + template.__schema__.subsetOf + " not found for " + template.__name__);
            template.__subsetOf__ = template.__schema__.subsetOf
            mergeRelationships(template.__schema__, mainTemplate.__schema__);
            template.__collection__ = mainTemplate.__collection__;
            template.__table__ = mainTemplate.__table__;
        }
        baseClassForPersist._injectIntoTemplate(template);

        function mergeRelationships(orig, overlay) {
            _.each(overlay.children,function (value, key) {
                orig.children = orig.children || {};
                if (!orig.children[key])
                    orig.children[key] = value;
            });
            _.each(overlay.parents,function (value, key) {
                orig.parents = orig.parents || {};
                if (!orig.parents[key])
                    orig.parents[key] = value;
            });
        }

        /**
         * Return a single instance of an object of this class given an id
         *
         * @param id
         */
        template.getFromPersistWithId = function(id, cascade, isTransient, idMap, isRefresh) {
            PersistObjectTemplate.debug("getFromPersistWithId " + template.__name__ + " " + id, 'api');
            var dbType = PersistObjectTemplate.getDB(PersistObjectTemplate.getDBAlias(template.__collection__)).type;
            var previousDirtyTracking = PersistObjectTemplate.__changeTracking__;
            PersistObjectTemplate.__changeTracking__ = false;
            return (dbType == PersistObjectTemplate.DB_Mongo ?
                PersistObjectTemplate.getFromPersistWithMongoId(template, id, cascade, isTransient, idMap) :
                PersistObjectTemplate.getFromPersistWithKnexId(template, id, cascade, isTransient, idMap, isRefresh))
                .then( function(res) {
                    return res;
                }.bind(this))
                .finally(function () {
                    PersistObjectTemplate.__changeTracking__ = previousDirtyTracking;
                });
        };

        /**
         * Return an array of objects of this class given a json query
         *
         * @param query
         */
        template.getFromPersistWithQuery = function(query, cascade, start, limit, isTransient, idMap, options) {
            PersistObjectTemplate.debug("getFromPersistWithQuery " + template.__name__, 'api');
            var dbType = PersistObjectTemplate.getDB(PersistObjectTemplate.getDBAlias(template.__collection__)).type;
            var previousDirtyTracking = PersistObjectTemplate.__changeTracking__;
            PersistObjectTemplate.__changeTracking__ = false;
            return (dbType == PersistObjectTemplate.DB_Mongo ?
                PersistObjectTemplate.getFromPersistWithMongoQuery(template, query, cascade, start, limit, isTransient, idMap, options) :
                PersistObjectTemplate.getFromPersistWithKnexQuery(null, template, query, cascade, start, limit, isTransient, idMap, options))
                .then( function(res) {
                    return res;
                }.bind(this))
                .finally(function () {
                    PersistObjectTemplate.__changeTracking__ = previousDirtyTracking;
                });
        };

        /**
         * Delete objects given a json query
         *
         * @param query
         */
        template.deleteFromPersistWithQuery = function(query, txn) {
            var dbType = PersistObjectTemplate.getDB(PersistObjectTemplate.getDBAlias(template.__collection__)).type;
            return dbType == PersistObjectTemplate.DB_Mongo ?
                PersistObjectTemplate.deleteFromPersistWithMongoQuery(template, query) :
                PersistObjectTemplate.deleteFromPersistWithKnexQuery(template, query, txn);
        };

        /**
         * Delete objects given a json query
         *
         * @param id
         */
        template.deleteFromPersistWithId = function(id, txn) {
            PersistObjectTemplate.debug("deleteFromPersistWithId " + template.__name__ + " " + id, 'api');
            var dbType = PersistObjectTemplate.getDB(PersistObjectTemplate.getDBAlias(template.__collection__)).type;
            var previousDirtyTracking = PersistObjectTemplate.__changeTracking__;
            return (dbType == PersistObjectTemplate.DB_Mongo ?
                PersistObjectTemplate.deleteFromPersistWithMongoId(template, id) :
                PersistObjectTemplate.deleteFromPersistWithKnexId(template, id, txn))
                .then( function(res) {
                    return res;
                }.bind(this))
                .finally(function () {
                    PersistObjectTemplate.__changeTracking__ = previousDirtyTracking;
                });
        };

        /**
         * Return count of objects of this class given a json query
         *
         * @param query
         */
        template.countFromPersistWithQuery = function(query) {
            PersistObjectTemplate.debug("countFromPersistWithQuery " + template.__name__, 'api');
            var dbType = PersistObjectTemplate.getDB(PersistObjectTemplate.getDBAlias(template.__collection__)).type;
            var previousDirtyTracking = PersistObjectTemplate.__changeTracking__;
            PersistObjectTemplate.__changeTracking__ = false;
            return (dbType == PersistObjectTemplate.DB_Mongo ?
                PersistObjectTemplate.countFromMongoQuery(template, query) :
                PersistObjectTemplate.countFromKnexQuery(template, query))
                .then( function(res) {
                    return res;
                }.bind(this))
                .finally(function () {
                    PersistObjectTemplate.__changeTracking__ = previousDirtyTracking;
                });
        };
        /**
         * Determine whether we are using knex on this table
         * @returns {boolean}
         */
        template.isKnex = function () {
            var dbType = PersistObjectTemplate.getDB(PersistObjectTemplate.getDBAlias(template.__collection__)).type;
            return dbType != PersistObjectTemplate.DB_Mongo;
        };
        /**
         * Get a knex object that can be used to create native queries (e.g. template.getKnex().select().from())
         * @returns {*}
         */
        template.getKnex = function () {
            var tableName = PersistObjectTemplate.dealias(template.__table__);
            return PersistObjectTemplate.getDB(PersistObjectTemplate.getDBAlias(template.__table__)).connection(tableName);
        }
        /**
         * Return knex table name for template for use in native queries
         * @param alias
         * @returns {string}
         */
        template.getTableName = function (alias) {
            return PersistObjectTemplate.dealias(template.__table__) + (alias ? ' as ' + alias : "");
        }
        /**
         * Return the foreign key for a given parent property for use in native queries
         * @param prop
         * @param alias
         * @returns {string}
         */
        template.getParentKey = function (prop, alias) {
            return (alias ? alias + '.'  : "") + template.__schema__.parents[prop].id;
        }
        /**
         * Return the foreign key for a given child property for use in native queries
         * @param prop
         * @param alias
         * @returns {string}
         */
        template.getChildKey = function (prop, alias) {
            return (alias ? alias + '.'  : "") + template.__schema__.children[prop].id;
        }
        /**
         * Return '_id'
         * @param alias
         * @returns {string}
         */
        template.getPrimaryKey = function (alias) {
            return (alias ? alias + '.'  : "") + '_id';
        }
        /**
         * return an array of join parameters (e.g. .rightOuterJoin.apply(template.getKnex(), Transaction.knexChildJoin(...)))
         * @param targetTemplate
         * @param primaryAlias
         * @param targetAlias
         * @param joinKey
         * @returns {*[]}
         */
        template.knexParentJoin = function (targetTemplate, primaryAlias, targetAlias, joinKey) {
            return [template.getTableName() + ' as ' + primaryAlias, targetTemplate.getParentKey(joinKey, targetAlias),template.getPrimaryKey(primaryAlias)];
        }
        /**
         * return an array of join parameters (e.g. .rightOuterJoin.apply(template.getKnex(), Transaction.knexChildJoin(...)))
         * @param targetTemplate
         * @param primaryAlias
         * @param targetAlias
         * @param joinKey
         * @returns {*[]}
         */
        template.knexChildJoin = function (targetTemplate, primaryAlias, targetAlias, joinKey) {
            return [template.getTableName() + ' as ' + primaryAlias, targetTemplate.getChildKey(joinKey, primaryAlias),targetTemplate.getPrimaryKey(targetAlias)];
        }
        // Add persistors to foreign key references

        var props = template.defineProperties;
        for (var prop in props) {
            var defineProperty = props[prop];
            var type = defineProperty.type;
            var collection = template.__collection__;
            var of = defineProperty.of;
            var refType = of || type;

            if (refType && refType.isObjectTemplate && PersistObjectTemplate._persistProperty(defineProperty)) {
                var isCrossDocRef = this.isCrossDocRef(template, prop, defineProperty)
                if (isCrossDocRef || defineProperty.autoFetch) {
                    (function () {
                        var closureProp = prop;
                        var closureFetch = defineProperty.fetch ? defineProperty.fetch : {};
                        var closureQueryOptions = defineProperty.queryOptions ? defineProperty.queryOptions : {};
                        var toClient = !(defineProperty.isLocal || (defineProperty.toClient === false))
                        if (!props[closureProp + 'Persistor'])
                            template.createProperty(closureProp + 'Persistor', {type: Object, toClient: toClient,
                                toServer: false, persist: false,
                                value: {isFetched: defineProperty.autoFetch ? false : true, isFetching: false}});
                        if (!template.prototype[closureProp + 'Fetch'])
                            template.createProperty(closureProp + 'Fetch', {on: "server", body: function (start, limit)
                            {
                                if (typeof(start) != 'undefined')
                                    closureQueryOptions['skip'] = start;
                                if (typeof(limit) != 'undefined')
                                    closureQueryOptions['limit'] = limit;
                                return this.fetchProperty(closureProp, closureFetch, closureQueryOptions);
                            }});
                    })();
                }
            }
        }
    }
    /**
     * PUBLIC INTERFACE FOR OBJECTTEMPLATE
     */

    /**
     * Begin a transaction that will ultimately be ended with end. It is passed into setDirty so
     * dirty objects can be accumulated.  Does not actually start a knex transaction until end
     * @returns {{dirtyObjects: Array}}
     */
    PersistObjectTemplate.begin = function (notDefault) {
        var txn = {id: new Date().getTime(), dirtyObjects: {}, savedObjects: {}, touchObjects: {}};
        if (!notDefault)
            this.currentTransaction = txn;
        return txn;
    }


    PersistObjectTemplate.end = function(persistorTransaction) {
        this.debug("end - start of transaction ", 'api');
        persistorTransaction = persistorTransaction || this.currentTransaction;
        var knex = _.findWhere(this._db, {type: PersistObjectTemplate.DB_Knex}).connection;
        var dirtyObjects = persistorTransaction ? persistorTransaction.dirtyObjects : this.dirtyObjects;
        var touchObjects = persistorTransaction ? persistorTransaction.touchObjects : {};
        var savedObjects = persistorTransaction ? persistorTransaction.savedObjects : {};
        var innerError;

        // Start the knext transaction
        return knex.transaction(function(knexTransaction) {

                persistorTransaction.knex = knexTransaction;

                Promise.resolve(true)
                    .then(processPreSave.bind(this))
                    .then(processSaves.bind(this))
                    .then(processTouches.bind(this))
                    .then(processPostSave.bind(this))
                    .then(processCommit.bind(this))
                    .catch(rollback.bind(this));

                function processPreSave() {
                    return persistorTransaction.preSave
                        ? persistorTransaction.preSave.call(persistorTransaction, persistorTransaction)
                        : true
                }

                // Walk through the dirty objects
                function processSaves() {
                    return Promise.map(_.toArray(dirtyObjects), function (obj) {
                        delete dirtyObjects[obj.__id__];  // Once scheduled for update remove it.
                        return (obj.__template__ && obj.__template__.__schema__
                            ?  obj.persistSave(persistorTransaction)
                            : true)
                    }.bind(this),{concurrency: PersistObjectTemplate.concurrency}).then (function () {
                        if(_.toArray(dirtyObjects). length > 0)
                            return processSaves.call(this);
                    });

                }

                function processPostSave() {
                    return persistorTransaction.postSave ? persistorTransaction.postSave(persistorTransaction)
                        : true;
                }

                // And we are done with everything
                function processCommit() {

                    this.dirtyObjects = {};
                    this.savedObjects = {};
                    if (persistorTransaction.updateConflict)
                        throw "Update Conflict";
                    return knexTransaction.commit();
                }

                // Walk through the touched objects
                function processTouches() {
                    return Promise.map(_.toArray(touchObjects), function (obj) {
                        return (obj.__template__ && obj.__template__.__schema__ && !savedObjects[obj.__id__]
                            ?  obj.persistTouch(persistorTransaction)
                            : true)
                    }.bind(this))
                }

                function rollback (err) {
                    return knexTransaction.rollback().then (function () {
                        var deadlock = err.toString().match(/deadlock detected$/i)
                        persistorTransaction.innerError = err;
                        innerError = deadlock ? new Error("Update Conflict") : err;
                        this.debug("end - transaction rolled back " + innerError.message + (deadlock ? " from deadlock" : ""), 'api');
                    }.bind(this));
                }
            }.bind(this))
            .then(function () {
                this.debug("end - transaction completed", 'api');
                return true;
            }.bind(this))
            .catch(function (e) {
                var err = e || innerError;
                if (err && err.message && err.message != 'Update Conflict')
                    this.debug("transaction ended with error " + err.message + err.stack, 'error');
                throw(e || innerError);
            }.bind(this))

    }
    /**
     * Set the object dirty along with all descendant objects in the logical "document"
     * @param obj
     * @param txn
     */
    PersistObjectTemplate.setDirty = function (obj, txn, onlyIfChanged, noCascade) {

        // Get array references too
        if (onlyIfChanged && this.MarkChangedArrayReferences)
            this.MarkChangedArrayReferences();

        txn = txn || this.currentTransaction;

        if (!obj || !obj.__template__.__schema__)
            return;

        // Use the current transaction if none passed
        txn = txn || PersistObjectTemplate.currentTransaction || null;

        if (!onlyIfChanged || obj.__changed__) {
            (txn ? txn.dirtyObjects : this.dirtyObjects)[obj.__id__] = obj;
        }

        if (txn && obj.__template__.__schema__.cascadeSave && !noCascade) {
            // Potentially cascade to set other related objects as dirty
            var topObject = PersistObjectTemplate.getTopObject(obj);
            if (!topObject)
                console.log("Warning: setDirty called for " + obj.__id__ + " which is an orphan");
            if (topObject && topObject.__template__.__schema__.cascadeSave) {
                PersistObjectTemplate.enumerateDocumentObjects(PersistObjectTemplate.getTopObject(obj), function (obj) {
                    if (!onlyIfChanged || obj.__changed__) {
                        (txn ? txn.dirtyObjects : this.dirtyObjects)[obj.__id__] = obj;
                        // Touch the top object if required so that if it will be modified and can be refereshed if needed
                        if (txn && txn.touchTop && obj.__template__.__schema__) {
                            var topObject = PersistObjectTemplate.getTopObject(obj);
                            if (topObject)
                                txn.touchObjects[topObject.__id__] = topObject;
                        }

                    }
                }.bind(this));
            }
        }
        if (txn && txn.touchTop && obj.__template__.__schema__) {
            var topObject = PersistObjectTemplate.getTopObject(obj);
            if (topObject)
                txn.touchObjects[topObject.__id__] = topObject;
        }
    }
    PersistObjectTemplate.saveAll = function (txn) {
        var promises = [];
        var somethingSaved = false;
        var dirtyObjects = txn ? txn.dirtyObjects : this.dirtyObjects;
        for (var id in dirtyObjects) {
            (function () {
                var obj = dirtyObjects[id];
                delete dirtyObjects[obj.__id__];
                promises.push(obj.persistSave(txn).then(function () {
                    PersistObjectTemplate.saved(obj,txn);
                    somethingSaved = true;
                }));
            })();
        };
        return Promise.all(promises)
            .then(function () {
                if (!somethingSaved && txn && txn.postSave) {
                    txn.postSave(txn);
                    this.dirtyObjects = {};
                    this.savedObjects = {};
                }
                if(somethingSaved)
                    return this.saveAll(txn)
                else
                    return true;
            }.bind(this));
    }

    /**
     * Set a data base to be used
     * @param db - the connection
     * @param type - the type which is defined in index.js
     * @param alias - An alias that can be used in the schema to specify the database at a table level
     */
    PersistObjectTemplate.setDB = function (db, type, alias) {
        type = type || PersistObjectTemplate.DB_Mongo;
        alias = alias || '__default__';
        this._db = this._db || {};
        this._db[alias] = {connection: db, type: type}
    }

    /**
     * retrieve a PLain Old Javascript Object given a query
     * @param template
     * @param query
     * @param options
     * @returns {*}
     */
    PersistObjectTemplate.getPOJOFromQuery = function (template, query, options) {
        var dbType = PersistObjectTemplate.getDB(PersistObjectTemplate.getDBAlias(template.__collection__)).type;
        var previousDirtyTracking = PersistObjectTemplate.__changeTracking__;
        var prefix = PersistObjectTemplate.dealias(template.__collection__)
        return dbType == PersistObjectTemplate.DB_Mongo ?
            PersistObjectTemplate.getPOJOFromMongoQuery(template, query, options) :
            PersistObjectTemplate.getPOJOsFromKnexQuery(template, [], query, options).then(function (pojos) {
                pojos.forEach(function (pojo) {
                    _.map(pojo, function(val, prop) {
                        if (prop.match(RegExp("^" + prefix + "___"))) {
                            pojo[prop.replace(RegExp("^" + prefix + "___"), '')] = pojo[prop];
                            delete pojo[prop];
                        }
                    });
                });
                return pojos;
            });
    }

}