import {
  Count,
  CountSchema,
  Filter,
  repository,
  Where,
} from '@loopback/repository';
import {
  // post,
  param,
  get,
  getFilterSchemaFor,
  getWhereSchemaFor,
  patch,
  // put,
  // del,
  requestBody,
} from '@loopback/rest';
import { ParameterizedSQL } from 'loopback-connector';
import { Trees } from '../models';
import { TreesRepository, DomainEventRepository } from '../repositories';
import { publishMessage } from '../messaging/RabbitMQMessaging.js';
import { config } from '../config.js';
import { v4 as uuid } from 'uuid';
import { Transaction } from 'loopback-connector';
import { getConnector, buildFilterQuery } from '../js/buildFilterQuery.js';

// Extend the LoopBack filter types for the Trees model to include tagId
// This is a workaround for the lack of proper join support in LoopBack
type TreesWhere = Where<Trees> & { tagId?: string; organizationId?: number };
type TreesFilter = Filter<Trees> & { where: TreesWhere };

export class TreesController {
  constructor(
    @repository(TreesRepository)
    public treesRepository: TreesRepository,
    @repository(DomainEventRepository)
    public domainEventRepository: DomainEventRepository,
  ) {}

  @get('/trees/count', {
    responses: {
      '200': {
        description: 'Trees model count',
        content: { 'application/json': { schema: CountSchema } },
      },
    },
  })
  async count(
    @param.query.object('where', getWhereSchemaFor(Trees)) where?: TreesWhere,
  ): Promise<Count> {
    // Replace organizationId with full entity tree and planter
    if (where && where.organizationId !== undefined) {
      const clause = await this.treesRepository.getOrganizationWhereClause(
        where.organizationId,
      );
      where = {
        ...where,
        ...clause,
      };
      delete where.organizationId;
    }

    // In order to filter by tagId (treeTags relation), we need to bypass the LoopBack count()
    if (where && where.tagId !== undefined) {
      try {
        const isTagNull = where.tagId === null;

        const sql = `SELECT COUNT(*) FROM trees ${
          isTagNull ? 'LEFT JOIN' : 'JOIN'
        } tree_tag ON trees.id=tree_tag.tree_id WHERE tree_tag.tag_id ${
          isTagNull ? 'IS NULL' : `=${where.tagId}`
        }`;

        const params = {
          filter: where,
          repo: this.treesRepository,
          model: 'Trees',
        };

        const query = buildFilterQuery(sql, params);

        return <Promise<Count>>(
          await this.treesRepository
            .execute(query.sql, query.params)
            .then((res) => {
              return (res && res[0]) || { count: 0 };
            })
        );
      } catch (e) {
        console.log(e);
        return await this.treesRepository.count(where);
      }
    } else {
      return await this.treesRepository.count(where);
    }
  }

  @get('/trees', {
    responses: {
      '200': {
        description: 'Array of Trees model instances',
        content: {
          'application/json': {
            schema: { type: 'array', items: { 'x-ts-type': Trees } },
          },
        },
      },
    },
  })
  async find(
    @param.query.object('filter', getFilterSchemaFor(Trees))
    filter?: TreesFilter,
  ): Promise<Trees[]> {
    console.log(filter, filter ? filter.where : null);

    // Replace plantingOrganizationId with full entity tree and planter
    if (filter && filter.where && filter.where.organizationId !== undefined) {
      const clause = await this.treesRepository.getOrganizationWhereClause(
        filter.where.organizationId,
      );
      filter.where = {
        ...filter.where,
        ...clause,
      };
      delete filter.where.organizationId;
    }

    // In order to filter by tagId (treeTags relation), we need to bypass the LoopBack find()
    if (filter && filter.where && filter.where.tagId !== undefined) {
      try {
        const connector = getConnector(this.treesRepository);
        if (connector) {
          // If included, replace 'id' with 'tree_id as id' to avoid ambiguity
          const columnNames = connector
            .buildColumnNames('Trees', filter)
            .replace('"id"', 'trees.id as "id"');

          const isTagNull = filter.where.tagId === null;

          const sql = `SELECT ${columnNames} from trees ${
            isTagNull
              ? 'LEFT JOIN tree_tag ON trees.id=tree_tag.tree_id ORDER BY "time_created" DESC'
              : 'JOIN tree_tag ON trees.id=tree_tag.tree_id'
          } WHERE tree_tag.tag_id ${
            isTagNull ? 'IS NULL' : `=${filter.where.tagId}`
          }`;

          const params = {
            filter: filter?.where,
            repo: this.treesRepository,
            model: 'Trees',
          };

          const query = buildFilterQuery(sql, params);

          return <Promise<Trees[]>>(
            await this.treesRepository
              .execute(query.sql, query.params)
              .then((data) => {
                return data.map((obj) => connector.fromRow('Trees', obj));
              })
          );
        } else {
          throw 'Connector not defined';
        }
      } catch (e) {
        console.log(e);
        return await this.treesRepository.find(filter);
      }
    } else {
      return await this.treesRepository.find(filter);
    }
  }

  @get('/trees/{id}', {
    responses: {
      '200': {
        description: 'Trees model instance',
        content: { 'application/json': { schema: { 'x-ts-type': Trees } } },
      },
    },
  })
  async findById(@param.path.number('id') id: number): Promise<Trees> {
    return await this.treesRepository.findById(id, {
      include: [{ relation: 'treeTags' }],
    });
  }

  // this route is for finding trees within a radius of a lat/lon point
  // execute commands for postgress seen here: https://github.com/strongloop/loopback-connector-postgresql/blob/master/lib/postgresql.js
  @get('/trees/near', {
    responses: {
      '200': {
        description: 'Find trees near a lat/lon with a radius in meters',
        content: {
          'application/json': {
            schema: { type: 'array', items: { 'x-ts-type': Trees } },
          },
        },
      },
    },
  })
  async near(
    @param.query.number('lat') lat: number,
    @param.query.number('lon') lon: number,
    @param({
      name: 'radius',
      in: 'query',
      required: false,
      schema: { type: 'number' },
      description: 'measured in meters (default: 100 meters)',
    })
    radius: number,
    @param({
      name: 'limit',
      in: 'query',
      required: false,
      schema: { type: 'number' },
      description: 'default is 100',
    })
    limit: number,
  ): Promise<Trees[]> {
    const query = `SELECT * FROM Trees WHERE ST_DWithin(ST_MakePoint(lat,lon), ST_MakePoint(${lat}, ${lon}), ${
      radius ? radius : 100
    }, false) LIMIT ${limit ? limit : 100}`;
    console.log(`near query: ${query}`);
    return <Promise<Trees[]>>await this.treesRepository.execute(query, []);
  }

  @patch('/trees/{id}', {
    responses: {
      '204': {
        description: 'Trees PATCH success',
      },
    },
  })
  async updateById(
    @param.path.number('id') id: number,
    @requestBody() trees: Trees,
  ): Promise<void> {
    const tx = await this.treesRepository.dataSource.beginTransaction({
      isolationLevel: Transaction.READ_COMMITTED,
    });
    try {
      let verifyCaptureProcessed;
      let domainEvent;
      if (config.enableVerificationPublishing) {
        const storedTree = await this.treesRepository.findById(id);
        // Raise an event to indicate verification is processed
        // on both rejection and approval
        if (
          (!trees.approved && !trees.active && storedTree.active) ||
          storedTree.approved != trees.approved
        ) {
          verifyCaptureProcessed = {
            id: storedTree.uuid,
            reference_id: storedTree.id,
            type: 'VerifyCaptureProcessed',
            approved: trees.approved,
            rejection_reason: trees.rejectionReason,
            created_at: new Date().toISOString(),
          };
          domainEvent = {
            id: uuid(),
            payload: verifyCaptureProcessed,
            status: 'raised',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          await this.domainEventRepository.create(domainEvent, {
            transaction: tx,
          });
        }
      }
      await this.treesRepository.updateById(id, trees, { transaction: tx });
      await tx.commit();
      if (verifyCaptureProcessed) {
        await publishMessage(verifyCaptureProcessed, () => {
          this.domainEventRepository.updateById(domainEvent.id, {
            status: 'sent',
            updatedAt: new Date().toISOString(),
          });
        });
      }
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }
}
