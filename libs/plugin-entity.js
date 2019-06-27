class DrupalJsonApiEntity {
  /**
   * Initialze our Drupal Json Api entity
   * @param {DrupalJsonApi} api
   */
  constructor (api, apiData, options = {}) {
    this.config = Object.assign({
      relationshipTests: [
        new RegExp(/^field_/),
        new RegExp(/^paragraphs$/)
      ],
      cleanEntity: (d) => this.transform(d),
      valueProcessors: {},
      isRelationship: i => typeof i === 'object' && i && !Array.isArray(i) && i.type && i.id && i.type.indexOf('--') > 1
    }, options)
    this.api = api
    this.res = this.config.cleanEntity(apiData)
    this.data = this.getData(this.res)
    this.attrs = this.res && this.res.data && this.res.data.attributes ? this.res.data.attributes : {}
    this.relationshipGroups = ['relationships']
    this._fieldMap = new Map()
    this._id = null
  }

  /**
   * Get the respective id of this entity.
   */
  get id () {
    if (!this._id) {
      const isId = new RegExp(/^drupal_internal__[a-z]?id$/)
      const key = Object.keys(this.attrs).find(k => isId.test(k))
      if (key) {
        this._id = this.attrs[key]
      }
    }
    return this._id
  }

  /**
   * Get the name of this bundle type.
   * @param {string} name
   */
  get entity () {
    return this.res.data.type.split('--')[0]
  }

  /**
   * Get the name of this bundle type.
   * @param {string} name
   */
  get type () {
    return this.entity
  }

  /**
   * Get the name of this bundle type.
   * @param {string} name
   */
  get bundle () {
    return this.res.data.type.split('--')[1]
  }

  /**
   * Get the data from our raw input.
   * @param {object}
   * @return {object}
   */
  getData (input) {
    if (input.data && input.data.type && input.data.id) {
      return input.data
    }
    if (input.type && input.id) {
      return input
    }
    if (input.data && Array.isArray(input.data)) {
      return input.data
    }
    return {}
  }

  /**
   * Checks if the current resource is a collection or a single resource.
   * @return {boolean}
   */
  isCollection () {
    return Array.isArray(this.data)
  }

  /**
   * Get a particular field name
   * @param {string} name
   * @return {mixed}
   */
  field (name) {
    if (!this.fieldMap.has(name)) {
      throw new Error(`The field (${name}) is not part of the entity (${this.entity})`)
    }
    return this.getPath(this.fieldMap.get(name))
  }

  /**
   * Get the (first) value of a particular field.
   * @param {string} name
   * @return {mixed}
   */
  value (name) {
    let field = this.field(name)
    if (typeof this.config.valueProcessors[field] === 'function') {
      return this.config.valueProcessors[field](field)
    }
    return this.getFieldValue(field)
  }

  /**
   * Get all the values for a particular field.
   * @param {string} name
   * @return {mixed}
   */
  allValues (name) {
    let fields = this.field(name)
    if (!Array.isArray(fields) && Array.isArray(fields.data)) {
      fields = fields.data
    }
    if (Array.isArray(fields)) {
      return fields.map((field, index) => this.getFieldValue(field))
    }
    return fields
  }

  /**
   * Given an input of field content, return an appropriate value at the given
   * index.
   * @param {data} structure
   * @param {integer} index
   */
  getFieldValue (structure, index = 0) {
    let value = structure
    if (typeof structure === 'object' && !!structure) {
      if (Array.isArray(structure.data)) {
        value = structure.data[index]
      } else if (structure.data) {
        value = structure.data
      }
    }
    if (Array.isArray(value) && value[index]) {
      value = value[index]
    }
    if (this.config.isRelationship(value)) {
      const [ entity, bundle ] = value.type.split('--')
      if (entity === 'paragraph' && bundle === 'from_library') {
        // @todo worth discussing this shorthand, but it seems like most devs
        // would not understand the internal entity structure for the entity
        // library and this creates a much more usable theming api.
        return this.api.getRelationship(value).value('field_reusable_paragraph').value('paragraphs')
      }
      return this.api.getRelationship(value)
    }
    return value
  }

  /**
   * Get the keys of all the fields on this property.
   * @return {array}
   */
  get fieldMap () {
    if (!this.isCollection() && !this._fieldMap.size) {
      const makePath = (keys, path) => keys.reduce((arr, k) => arr.concat([[k, path.concat(k)]]), [])
      this._fieldMap = new Map(this.relationshipGroups
        .reduce(
          (fields, group) => fields.concat(makePath(this.relationshipFieldNames(group), ['data', group])),
          makePath(Object.keys(this.attrs), ['data', 'attributes'])
        ))
    }
    return this._fieldMap
  }

  /**
   * Get the value at a given path.
   * @param {array} path
   */
  getPath (path) {
    return path.reduce((value, key) => value[key], this.res)
  }

  /**
   * Given a group name (top level json:api result key) return field names that
   * are valid field names.
   * @param {string} group
   */
  relationshipFieldNames (group) {
    return Object.keys(this.data[group] || [])
      .filter(k => this.config.relationshipTests.some(r => r.test(k)))
  }

  /**
   * Load all the sub relationships of this entity.
   */
  async loadRelationships (depth) {
    return Promise.all(this.relationshipGroups.reduce((promises, group) => {
      return promises.concat(this.loadRelationshipGroup(group, depth))
    }, []))
  }

  /**
   * Load a group of relationships.
   * @param {string} group
   * @return {[Promise]}
   */
  loadRelationshipGroup (group, depth) {
    if (!this.isCollection() && this.data[group]) {
      const lookups = Object.values(this.parseRelationshipLookups(
        this.relationshipFieldNames(group).map(k => this.data[group][k])
      ))
      return lookups
        .filter(l => !this.api.hasBeenTraversed(l))
        .map(l => this.api.getEntity(l, depth + 1))
    }
    return []
  }

  /**
   * Given an array or object, recursively seek out all relationships.
   * @param {array|object} set
   * @return {Set}
   */
  parseRelationshipLookups (items) {
    if (this.config.isRelationship(items)) {
      const l = this.dataToLookup(items)
      return { [this.api.endpoint(l)]: l }
    }
    if (typeof items === 'object' && !!items) {
      items = (!Array.isArray(items)) ? Object.values(items) : items
      return items.reduce((set, item) => Object.assign(set, this.parseRelationshipLookups(item)), {})
    }
    return {}
  }

  /**
   * Convert object data to a url.
   * @param {object} data
   */
  dataToLookup (data) {
    const [ entity, bundle ] = data.type.split('--')
    return {
      entity,
      bundle,
      uuid: data.id
    }
  }

  /**
   * Transform this entity into a simple object that can re-constitute this
   * entity down the road.
   */
  toObject () {
    return this.res
  }

  /**
   * Allow this component to be serialized.
   */
  toJSON () {
    return JSON.stringify({
      __NUXT_SERIALIZED__: {
        res: this.res,
        cache: this.api.cacheToObject()
      }
    })
  }

  /**
   * Represent this instance with a string.
   */
  toString () {
    return `Drupal '${this.entity}' entity of bundle '${this.bundle}'. Has fields: ${Array.from(this.fieldMap.keys()).join(', ')}.`
  }

  /**
   * Given a full json:api entity object, remove all unnecessary data.
   * @param {object} res
   */
  transform (res) {
    delete res.jsonapi
    delete res.links
    if (res.data && res.data.links) {
      delete res.data.links
    }
    ['attributes', 'relationships']
      .forEach(fieldSet => Object.assign(res.data, { [ fieldSet ]: this.cleanFields(res.data[fieldSet]) }))
    return res
  }

  /**
   * Given a set of fields. Clean them.
   * @param {string} fields
   */
  cleanFields (fields) {
    const fieldTests = [
      /^field_/,
      /^drupal_internal_[a-z]?id$/,
      /^(label|title|status|path|paragraphs)$/
    ]
    return Object.keys(fields)
      .filter(k => fieldTests.some(t => t.test(k)))
      .reduce((group, field) => Object.assign(group, { [ field ]: this.cleanField(fields[field]) }), {})
  }

  /**
   * Clean a particular field.
   * @param {mixed}
   * @return {mixed}
   */
  cleanField (field) {
    if (!Array.isArray(field) && typeof field === 'object' && !!field) {
      if (field.links && field.links.self) {
        delete field.links
      }
      if (field.data && Array.isArray(field.data)) {
        field.data = this.cleanField(field.data)
      }
    } else if (Array.isArray(field)) {
      field = field.map(f => this.cleanField(f))
    }
    return field
  }
}

export default DrupalJsonApiEntity