--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ducklake_column; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_column (
    column_id bigint,
    begin_snapshot bigint,
    end_snapshot bigint,
    table_id bigint,
    column_order bigint,
    column_name character varying,
    column_type character varying,
    initial_default character varying,
    default_value character varying,
    nulls_allowed boolean,
    parent_column bigint,
    default_value_type character varying,
    default_value_dialect character varying
);


--
-- Name: ducklake_column_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_column_mapping (
    mapping_id bigint,
    table_id bigint,
    type character varying
);


--
-- Name: ducklake_column_tag; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_column_tag (
    table_id bigint,
    column_id bigint,
    begin_snapshot bigint,
    end_snapshot bigint,
    key character varying,
    value character varying
);


--
-- Name: ducklake_data_file; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_data_file (
    data_file_id bigint NOT NULL,
    table_id bigint,
    begin_snapshot bigint,
    end_snapshot bigint,
    file_order bigint,
    path character varying,
    path_is_relative boolean,
    file_format character varying,
    record_count bigint,
    file_size_bytes bigint,
    footer_size bigint,
    row_id_start bigint,
    partition_id bigint,
    encryption_key character varying,
    mapping_id bigint,
    partial_max bigint,
    row_group_count bigint
);


--
-- Name: ducklake_delete_file; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_delete_file (
    delete_file_id bigint NOT NULL,
    table_id bigint,
    begin_snapshot bigint,
    end_snapshot bigint,
    data_file_id bigint,
    path character varying,
    path_is_relative boolean,
    format character varying,
    delete_count bigint,
    file_size_bytes bigint,
    footer_size bigint,
    encryption_key character varying,
    partial_max bigint,
    row_group_count bigint
);


--
-- Name: ducklake_file_column_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_file_column_stats (
    data_file_id bigint,
    table_id bigint,
    column_id bigint,
    column_size_bytes bigint,
    value_count bigint,
    null_count bigint,
    min_value character varying,
    max_value character varying,
    contains_nan boolean,
    extra_stats character varying,
    min_is_exact boolean,
    max_is_exact boolean
);


--
-- Name: ducklake_file_partition_value; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_file_partition_value (
    data_file_id bigint,
    table_id bigint,
    partition_key_index bigint,
    partition_value character varying
);


--
-- Name: ducklake_file_variant_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_file_variant_stats (
    data_file_id bigint,
    table_id bigint,
    column_id bigint,
    variant_path character varying,
    shredded_type character varying,
    column_size_bytes bigint,
    value_count bigint,
    null_count bigint,
    min_value character varying,
    max_value character varying,
    contains_nan boolean,
    extra_stats character varying
);


--
-- Name: ducklake_files_scheduled_for_deletion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_files_scheduled_for_deletion (
    data_file_id bigint,
    path character varying,
    path_is_relative boolean,
    schedule_start timestamp with time zone
);


--
-- Name: ducklake_inlined_data_tables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_inlined_data_tables (
    table_id bigint,
    table_name character varying,
    schema_version bigint
);


--
-- Name: ducklake_macro; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_macro (
    schema_id bigint,
    macro_id bigint,
    macro_name character varying,
    begin_snapshot bigint,
    end_snapshot bigint
);


--
-- Name: ducklake_macro_impl; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_macro_impl (
    macro_id bigint,
    impl_id bigint,
    dialect character varying,
    sql character varying,
    type character varying
);


--
-- Name: ducklake_macro_parameters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_macro_parameters (
    macro_id bigint,
    impl_id bigint,
    column_id bigint,
    parameter_name character varying,
    parameter_type character varying,
    default_value character varying,
    default_value_type character varying
);


--
-- Name: ducklake_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_metadata (
    key character varying NOT NULL,
    value character varying NOT NULL,
    scope character varying,
    scope_id bigint
);


--
-- Name: ducklake_name_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_name_mapping (
    mapping_id bigint,
    column_id bigint,
    source_name character varying,
    target_field_id bigint,
    parent_column bigint,
    is_partition boolean
);


--
-- Name: ducklake_partition_column; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_partition_column (
    partition_id bigint,
    table_id bigint,
    partition_key_index bigint,
    column_id bigint,
    transform character varying
);


--
-- Name: ducklake_partition_info; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_partition_info (
    partition_id bigint,
    table_id bigint,
    begin_snapshot bigint,
    end_snapshot bigint
);


--
-- Name: ducklake_schema; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_schema (
    schema_id bigint NOT NULL,
    schema_uuid uuid,
    begin_snapshot bigint,
    end_snapshot bigint,
    schema_name character varying,
    path character varying,
    path_is_relative boolean,
    parent_schema_id bigint
);


--
-- Name: ducklake_schema_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_schema_versions (
    begin_snapshot bigint,
    schema_version bigint,
    table_id bigint
);


--
-- Name: ducklake_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_snapshot (
    snapshot_id bigint NOT NULL,
    snapshot_time timestamp with time zone,
    schema_version bigint,
    next_catalog_id bigint,
    next_file_id bigint
);


--
-- Name: ducklake_snapshot_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_snapshot_changes (
    snapshot_id bigint NOT NULL,
    changes_made character varying,
    author character varying,
    commit_message character varying,
    commit_extra_info character varying
);


--
-- Name: ducklake_sort_expression; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_sort_expression (
    sort_id bigint,
    table_id bigint,
    sort_key_index bigint,
    expression character varying,
    dialect character varying,
    sort_direction character varying,
    null_order character varying
);


--
-- Name: ducklake_sort_info; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_sort_info (
    sort_id bigint,
    table_id bigint,
    begin_snapshot bigint,
    end_snapshot bigint
);


--
-- Name: ducklake_table; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_table (
    table_id bigint,
    table_uuid uuid,
    begin_snapshot bigint,
    end_snapshot bigint,
    schema_id bigint,
    table_name character varying,
    path character varying,
    path_is_relative boolean
);


--
-- Name: ducklake_table_column_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_table_column_stats (
    table_id bigint,
    column_id bigint,
    contains_null boolean,
    contains_nan boolean,
    min_value character varying,
    max_value character varying,
    extra_stats character varying,
    min_is_exact boolean,
    max_is_exact boolean
);


--
-- Name: ducklake_table_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_table_stats (
    table_id bigint,
    record_count bigint,
    next_row_id bigint,
    file_size_bytes bigint
);


--
-- Name: ducklake_tag; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_tag (
    object_id bigint,
    begin_snapshot bigint,
    end_snapshot bigint,
    key character varying,
    value character varying
);


--
-- Name: ducklake_view; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_view (
    view_id bigint,
    view_uuid uuid,
    begin_snapshot bigint,
    end_snapshot bigint,
    schema_id bigint,
    view_name character varying,
    dialect character varying,
    sql character varying,
    column_aliases character varying
);


--
-- Name: ducklake_view_column_tag; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_view_column_tag (
    view_id bigint,
    column_name character varying,
    begin_snapshot bigint,
    end_snapshot bigint,
    key character varying,
    value character varying
);


--
-- Data for Name: ducklake_column; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (1, 2, NULL, 2, 1, 'id', 'int32', NULL, 'NULL', false, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (2, 2, NULL, 2, 2, 'customer', 'struct', NULL, 'NULL', true, NULL, '', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (3, 2, NULL, 2, 3, 'name', 'varchar', NULL, 'NULL', true, 2, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (4, 2, NULL, 2, 4, 'tags', 'list', NULL, 'NULL', true, 2, '', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (5, 2, NULL, 2, 5, 'element', 'varchar', NULL, 'NULL', true, 4, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (6, 2, NULL, 2, 6, 'attrs', 'map', NULL, 'NULL', true, NULL, '', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (7, 2, NULL, 2, 7, 'key', 'varchar', NULL, 'NULL', true, 6, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (8, 2, NULL, 2, 8, 'value', 'int32', NULL, 'NULL', true, 6, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (9, 2, NULL, 2, 9, 'amount', 'decimal(10,2)', '0.00', '0', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (10, 2, NULL, 2, 10, 'created', 'timestamp', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (1, 3, 11, 3, 1, 'a', 'int32', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (1, 12, NULL, 5, 1, 'x', 'int64', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (2, 12, NULL, 5, 2, 'y', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (3, 13, NULL, 5, 3, 'z', 'float64', NULL, 'NULL', true, NULL, 'literal', 'duckdb');


--
-- Data for Name: ducklake_column_mapping; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_column_tag; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_column_tag (table_id, column_id, begin_snapshot, end_snapshot, key, value) VALUES (2, 9, 9, NULL, 'comment', 'Net amount in EUR');


--
-- Data for Name: ducklake_data_file; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (0, 2, 4, NULL, NULL, 'ducklake-01a189a8-c10a-7ebf-a8ba-07f50d3bd0f7.parquet', true, 'parquet', 3, 1160, 847, 0, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (1, 3, 5, 11, NULL, 'ducklake-01a189a8-c12e-75b8-b4fc-9bc713aa1256.parquet', true, 'parquet', 1, 203, 162, 0, NULL, NULL, NULL, NULL, 1);


--
-- Data for Name: ducklake_delete_file; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_delete_file (delete_file_id, table_id, begin_snapshot, end_snapshot, data_file_id, path, path_is_relative, format, delete_count, file_size_bytes, footer_size, encryption_key, partial_max, row_group_count) VALUES (2, 2, 6, NULL, 0, 'ducklake-01a189a8-c16a-72b1-855d-ece6dfd176d6-delete.parquet', true, 'parquet', 1, 793, 637, NULL, NULL, 1);


--
-- Data for Name: ducklake_file_column_stats; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (0, 2, 1, 37, 3, 0, '1', '3', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (0, 2, 3, 41, 2, 1, 'a', 'b', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (0, 2, 5, 45, 1, 2, 'x', 'x', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (0, 2, 7, 42, 1, 2, 'k', 'k', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (0, 2, 8, 41, 1, 2, '1', '1', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (0, 2, 9, 46, 3, 0, '1.50', '3.00', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (0, 2, 10, 49, 3, 0, '2026-01-01 00:00:00', '2026-01-03 00:00:00', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (1, 3, 1, 29, 1, 0, '1', '1', NULL, NULL, true, true);


--
-- Data for Name: ducklake_file_partition_value; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_file_variant_stats; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_files_scheduled_for_deletion; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_inlined_data_tables; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_macro; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_macro_impl; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_macro_parameters; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_metadata; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_metadata (key, value, scope, scope_id) VALUES ('version', '1.1', NULL, NULL);
INSERT INTO public.ducklake_metadata (key, value, scope, scope_id) VALUES ('created_by', 'DuckDB d54cbbe3df', NULL, NULL);
INSERT INTO public.ducklake_metadata (key, value, scope, scope_id) VALUES ('data_path', '/tmp/aantje-fixture-data/', NULL, NULL);
INSERT INTO public.ducklake_metadata (key, value, scope, scope_id) VALUES ('encrypted', 'false', NULL, NULL);


--
-- Data for Name: ducklake_name_mapping; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_partition_column; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_partition_info; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_schema; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_schema (schema_id, schema_uuid, begin_snapshot, end_snapshot, schema_name, path, path_is_relative, parent_schema_id) VALUES (0, '01a189a8-bd56-7839-a64a-63906fe14410', 0, NULL, 'main', 'main/', true, NULL);
INSERT INTO public.ducklake_schema (schema_id, schema_uuid, begin_snapshot, end_snapshot, schema_name, path, path_is_relative, parent_schema_id) VALUES (1, '01a189a8-bf2a-73e2-990e-be3d46637852', 1, NULL, 'sales', 'sales/', true, NULL);


--
-- Data for Name: ducklake_schema_versions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (2, 2, 2);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (3, 3, 3);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (12, 9, 5);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (13, 10, 5);


--
-- Data for Name: ducklake_snapshot; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (0, '2026-10-29 21:54:59.442576+00', 0, 1, 0);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (1, '2026-10-29 21:55:00.004113+00', 1, 2, 0);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (2, '2026-10-29 21:55:00.022226+00', 2, 3, 0);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (3, '2026-10-29 21:55:00.190486+00', 3, 4, 0);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (4, '2026-10-29 21:55:00.393552+00', 3, 4, 1);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (5, '2026-10-29 21:55:00.520766+00', 3, 4, 2);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (6, '2026-10-29 21:55:00.551401+00', 3, 4, 3);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (7, '2026-10-29 21:55:00.605813+00', 4, 5, 3);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (8, '2026-10-29 21:55:00.700855+00', 5, 5, 3);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (9, '2026-10-29 21:55:00.829587+00', 6, 5, 3);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (10, '2026-10-29 21:55:01.009218+00', 7, 5, 3);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (11, '2026-10-29 21:55:01.20272+00', 8, 5, 3);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (12, '2026-10-29 21:55:01.298755+00', 9, 6, 3);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (13, '2026-10-29 21:55:01.438781+00', 10, 6, 3);


--
-- Data for Name: ducklake_snapshot_changes; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (0, 'created_schema:"main"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (1, 'created_schema:"sales"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (2, 'created_table:"sales"."orders"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (3, 'created_table:"sales"."tmp"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (4, 'inserted_into_table:2', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (5, 'inserted_into_table:3', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (6, 'deleted_from_table:2', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (7, 'created_view:"sales"."big_orders"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (8, 'altered_table:2', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (9, 'altered_table:2', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (10, 'altered_view:4', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (11, 'dropped_table:3', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (12, 'created_table:"main"."plain"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (13, 'altered_table:5', NULL, NULL, NULL);


--
-- Data for Name: ducklake_sort_expression; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_sort_info; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_table; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_table (table_id, table_uuid, begin_snapshot, end_snapshot, schema_id, table_name, path, path_is_relative) VALUES (2, '01a189a8-bf89-75de-8e53-328a26017531', 2, NULL, 1, 'orders', 'orders/', true);
INSERT INTO public.ducklake_table (table_id, table_uuid, begin_snapshot, end_snapshot, schema_id, table_name, path, path_is_relative) VALUES (3, '01a189a8-c044-7873-aa49-c90ed6c34aa5', 3, 11, 1, 'tmp', 'tmp/', true);
INSERT INTO public.ducklake_table (table_id, table_uuid, begin_snapshot, end_snapshot, schema_id, table_name, path, path_is_relative) VALUES (5, '01a189a8-c47b-79b9-b21d-99d56851f206', 12, NULL, 0, 'plain', 'plain/', true);


--
-- Data for Name: ducklake_table_column_stats; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (2, 1, false, NULL, '1', '3', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (2, 3, true, NULL, 'a', 'b', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (2, 5, true, NULL, 'x', 'x', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (2, 7, true, NULL, 'k', 'k', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (2, 8, true, NULL, '1', '1', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (2, 9, false, NULL, '1.50', '3.00', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (2, 10, false, NULL, '2026-01-01 00:00:00', '2026-01-03 00:00:00', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (3, 1, false, NULL, '1', '1', NULL, true, true);


--
-- Data for Name: ducklake_table_stats; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_table_stats (table_id, record_count, next_row_id, file_size_bytes) VALUES (2, 3, 3, 1160);
INSERT INTO public.ducklake_table_stats (table_id, record_count, next_row_id, file_size_bytes) VALUES (3, 1, 1, 203);


--
-- Data for Name: ducklake_tag; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_tag (object_id, begin_snapshot, end_snapshot, key, value) VALUES (2, 8, NULL, 'comment', 'Customer orders');
INSERT INTO public.ducklake_tag (object_id, begin_snapshot, end_snapshot, key, value) VALUES (4, 10, NULL, 'comment', 'Orders above 1');


--
-- Data for Name: ducklake_view; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_view (view_id, view_uuid, begin_snapshot, end_snapshot, schema_id, view_name, dialect, sql, column_aliases) VALUES (4, 'cf397d35-0550-4a0e-b6b6-a12ff7c585be', 7, NULL, 1, 'big_orders', 'duckdb', 'SELECT * FROM sales.orders WHERE (amount > 1)', '');


--
-- Data for Name: ducklake_view_column_tag; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Name: ducklake_data_file ducklake_data_file_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ducklake_data_file
    ADD CONSTRAINT ducklake_data_file_pkey PRIMARY KEY (data_file_id);


--
-- Name: ducklake_delete_file ducklake_delete_file_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ducklake_delete_file
    ADD CONSTRAINT ducklake_delete_file_pkey PRIMARY KEY (delete_file_id);


--
-- Name: ducklake_schema ducklake_schema_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ducklake_schema
    ADD CONSTRAINT ducklake_schema_pkey PRIMARY KEY (schema_id);


--
-- Name: ducklake_snapshot_changes ducklake_snapshot_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ducklake_snapshot_changes
    ADD CONSTRAINT ducklake_snapshot_changes_pkey PRIMARY KEY (snapshot_id);


--
-- Name: ducklake_snapshot ducklake_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ducklake_snapshot
    ADD CONSTRAINT ducklake_snapshot_pkey PRIMARY KEY (snapshot_id);


--
-- PostgreSQL database dump complete
--


