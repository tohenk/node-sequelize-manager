# Sequelize Model Manager

Sequelize Model Manager provides functionality to handle loading, applying
some extensions to model, synchronize models to database, inserting fixtures
and so on. The models to manage can be generated using [MySQL Workbench Schema Exporter](https://github.com/mysql-workbench-schema-exporter/sequelize-exporter).

The directory layout suggested as follows:

```
> model                       <- contains model classes
  > addon                     <- contains handler for all models extension
  > data
    > lifecycle.json
    > tostring.json
  > extend                    <- contains model extension
  > extension                 <- contains model attributes extension
  > fixture                   <- contains fixture data
    > Model1.json
  > hook                      <- contains lifecycle handler
    > audit.js
  > Model1.js
  > Model2.js
```

## Usage

Sequelize Model Manager constructor accepts an options described below:

* `modeldir`: The path which contains models will be looked for
* `extensiondir`: The extension directory, will use `modeldir/extension` if not specified
* `hookdir`: The hook directory, will use `modeldir/hook` if not specified
* `datadir`: The data directory, will use `modeldir/data` if not specified
* `extenddir`: The extend directory, will use `modeldir/extend` if not specified
* `addondir`: The addon directory, will use `modeldir/addon` if not specified
* `fixturedir`: The fixture directory, will use `modeldir/fixture` if not specified
* `onconnect`: A function which returns `Promise` and called when finishing `connectToDatase()`
* `onpopulate`: A function which called when populating each row form fixture

An example usage of Sequelize Model Manager shown below:

```js

const SequelizeManager = require('./sequelize-manager');

const db = new SequelizeManager({
    modeldir: path.join(__dirname, 'model'),
});

(async function run() {
    await db.init({
        dialect: 'sqlite',
        storage: './data/mydb.sqlite'
    });
    await db.connectDatabase();
    await db.syncModels();
    await db.loadFixtures();

    // find a row in database
    const m = await db.Model1.findOne({where: {Id: 990}});
})();
```