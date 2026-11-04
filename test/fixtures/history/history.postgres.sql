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
-- Name: ducklake_inlined_data_10_12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ducklake_inlined_data_10_12 (
    _ducklake_row_id bigint,
    _ducklake_begin_snapshot bigint,
    _ducklake_end_snapshot bigint,
    id integer,
    body bytea
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

INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (1, 4, NULL, 3, 1, 'id', 'int32', NULL, 'NULL', false, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (2, 4, NULL, 3, 2, 'kind', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (3, 4, NULL, 3, 3, 'ts', 'timestamp', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (4, 4, NULL, 3, 4, 'amount', 'decimal(10,2)', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (1, 11, NULL, 6, 1, 'sensor', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (2, 11, NULL, 6, 2, 'taken_at', 'timestamp', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (3, 11, NULL, 6, 3, 'value', 'float64', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (1, 15, NULL, 9, 1, 'id', 'int32', NULL, 'NULL', false, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (2, 15, NULL, 9, 2, 'name', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (3, 15, NULL, 9, 3, 'tier', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (1, 19, NULL, 10, 1, 'id', 'int32', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (2, 19, NULL, 10, 2, 'body', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (1, 24, NULL, 11, 1, 'id', 'int32', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (2, 24, NULL, 11, 2, 'note', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (1, 26, NULL, 12, 1, 'id', 'int32', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (3, 26, NULL, 12, 3, 'info', 'struct', NULL, 'NULL', true, NULL, '', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (4, 26, NULL, 12, 4, 'a', 'int32', NULL, 'NULL', true, 3, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (5, 26, NULL, 12, 5, 'b', 'varchar', NULL, 'NULL', true, 3, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (2, 26, 29, 12, 2, 'name', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (2, 29, NULL, 12, 2, 'title', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (6, 26, 30, 12, 6, 'n', 'int32', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (6, 30, NULL, 12, 6, 'n', 'int64', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (7, 28, 31, 12, 7, 'extra', 'float64', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (8, 32, NULL, 12, 8, 'c', 'float64', NULL, 'NULL', false, 3, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (9, 33, 34, 12, 9, 'flag', 'boolean', 'false', 'false', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (9, 34, NULL, 12, 9, 'flag', 'boolean', 'false', 'true', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (1, 43, 45, 15, 1, 'x', 'int32', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (1, 50, NULL, 19, 1, 'id', 'int32', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
INSERT INTO public.ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect) VALUES (2, 50, NULL, 19, 2, 'msg', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');


--
-- Data for Name: ducklake_column_mapping; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_column_tag; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_column_tag (table_id, column_id, begin_snapshot, end_snapshot, key, value) VALUES (9, 3, 38, NULL, 'comment', 'bronze, silver or gold');


--
-- Data for Name: ducklake_data_file; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (0, 3, 6, NULL, NULL, 'kind=click/year=2025/ducklake-01a18cd6-dbff-71c1-bb9a-01daf384f15d.parquet', true, 'parquet', 3, 658, 477, 0, 4, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (1, 3, 6, NULL, NULL, 'kind=click/year=2026/ducklake-01a18cd6-dc00-70a3-9922-588441ef9608.parquet', true, 'parquet', 1, 618, 477, 3, 4, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (2, 3, 6, NULL, NULL, 'kind=view/year=2025/ducklake-01a18cd6-dc00-7881-aefa-ef6ed927a1a2.parquet', true, 'parquet', 2, 641, 473, 4, 4, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (3, 3, 7, NULL, NULL, 'kind=view/year=2026/ducklake-01a18cd6-dc0d-7c38-acbb-81841e07206b.parquet', true, 'parquet', 1, 613, 473, 6, 4, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (4, 3, 8, NULL, NULL, 'kind=click/year=2025/ducklake-01a18cd6-dc19-7116-b052-ae7b8ed386a5.parquet', true, 'parquet', 40, 1328, 501, 7, 4, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (5, 3, 10, NULL, NULL, 'kind=click/month=3/ducklake-01a18cd6-dc72-7100-859b-28686a2edd94.parquet', true, 'parquet', 2, 647, 477, 47, 5, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (6, 3, 10, NULL, NULL, 'kind=click/month=4/ducklake-01a18cd6-dc73-7bd8-950e-726931cac3c0.parquet', true, 'parquet', 1, 618, 477, 49, 5, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (7, 3, 10, NULL, NULL, 'kind=view/month=3/ducklake-01a18cd6-dc74-7444-8148-b70f2b2a240e.parquet', true, 'parquet', 1, 613, 473, 50, 5, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (8, 6, 13, NULL, NULL, 'ducklake-01a18cd6-dd1e-7251-8a45-197430a9cf10.parquet', true, 'parquet', 4, 545, 382, 0, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (9, 9, 16, NULL, NULL, 'ducklake-01a18cd6-dde0-75f7-b395-1417a4236471.parquet', true, 'parquet', 4, 495, 337, 0, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (10, 9, 17, NULL, NULL, 'ducklake-01a18cd6-de03-72ea-9b2b-24d4ab42c4d0.parquet', true, 'parquet', 1, 617, 478, 4, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (15, 3, 23, NULL, NULL, 'kind=view/month=4/ducklake-01a18cd6-df2d-7f7f-9bb4-c1e7b3c88884.parquet', true, 'parquet', 1, 613, 473, 51, 5, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (16, 9, 23, NULL, NULL, 'ducklake-01a18cd6-df29-7dfb-a2d9-e0730ab39f47.parquet', true, 'parquet', 1, 447, 339, 5, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (17, 11, 24, NULL, NULL, 'ducklake-01a18cd6-df42-760d-b1df-4efed103c126.parquet', true, 'parquet', 1, 480, 375, 0, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (18, 9, 25, NULL, NULL, 'ducklake-01a18cd6-dfa5-739d-b7c4-5102a773c088.parquet', true, 'parquet', 1, 447, 339, 6, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (19, 12, 27, NULL, NULL, 'ducklake-01a18cd6-e010-7d95-80cc-fb5e8e1964a8.parquet', true, 'parquet', 1, 655, 494, 0, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (20, 12, 36, NULL, NULL, 'ducklake-01a18cd6-e29e-7eda-bdc2-c0d33f217b90.parquet', true, 'parquet', 1, 907, 683, 1, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (21, 15, 44, 45, NULL, 'ducklake-01a18cd6-e462-734c-8700-13be41b19c31.parquet', true, 'parquet', 2, 207, 162, 0, NULL, NULL, NULL, NULL, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (26, 19, 51, NULL, NULL, 'ducklake-01a18cd6-e5ac-75cb-bf4f-16fc1db1867a.parquet', true, 'parquet', 4, 750, 560, 0, NULL, NULL, NULL, 54, 1);
INSERT INTO public.ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, footer_size, row_id_start, partition_id, encryption_key, mapping_id, partial_max, row_group_count) VALUES (27, 19, 56, NULL, NULL, 'ducklake-01a18cd6-e5c0-7af2-ab1d-c5c3c167d83a.parquet', true, 'parquet', 1, 331, 255, 4, NULL, NULL, NULL, NULL, 1);


--
-- Data for Name: ducklake_delete_file; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_delete_file (delete_file_id, table_id, begin_snapshot, end_snapshot, data_file_id, path, path_is_relative, format, delete_count, file_size_bytes, footer_size, encryption_key, partial_max, row_group_count) VALUES (12, 9, 17, NULL, 9, 'ducklake-01a18cd6-de1f-74f0-869b-f060ca2cccad-delete.parquet', true, 'parquet', 2, 1011, 802, NULL, 18, 1);


--
-- Data for Name: ducklake_file_column_stats; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (0, 3, 1, 37, 3, 0, '1', '3', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (0, 3, 2, 37, 3, 0, 'click', 'click', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (0, 3, 3, 49, 3, 0, '2025-03-01 10:00:00', '2025-03-03 10:00:00', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (0, 3, 4, 46, 3, 0, '1.50', '3.50', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (1, 3, 1, 29, 1, 0, '6', '6', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (1, 3, 2, 34, 1, 0, 'click', 'click', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (1, 3, 3, 33, 1, 0, '2026-01-05 10:00:00', '2026-01-05 10:00:00', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (1, 3, 4, 33, 1, 0, '6.50', '6.50', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (2, 3, 1, 33, 2, 0, '4', '5', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (2, 3, 2, 41, 2, 0, 'view', 'view', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (2, 3, 3, 41, 2, 0, '2025-04-01 10:00:00', '2025-04-02 10:00:00', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (2, 3, 4, 41, 2, 0, '4.50', '5.50', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (3, 3, 1, 29, 1, 0, '7', '7', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (3, 3, 2, 33, 1, 0, 'view', 'view', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (3, 3, 3, 33, 1, 0, '2026-01-06 10:00:00', '2026-01-06 10:00:00', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (3, 3, 4, 33, 1, 0, '7.50', '7.50', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (4, 3, 1, 189, 40, 0, '100', '139', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (4, 3, 2, 52, 40, 0, 'click', 'click', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (4, 3, 3, 305, 40, 0, '2025-06-01 00:00:00', '2025-06-02 15:00:00', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (4, 3, 4, 222, 40, 0, '0.00', '58.50', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (5, 3, 1, 33, 2, 0, '8', '9', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (5, 3, 2, 43, 2, 0, 'click', 'click', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (5, 3, 3, 41, 2, 0, '2026-03-05 10:00:00', '2026-03-06 10:00:00', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (5, 3, 4, 41, 2, 0, '8.50', '9.50', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (6, 3, 1, 29, 1, 0, '11', '11', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (6, 3, 2, 34, 1, 0, 'click', 'click', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (6, 3, 3, 33, 1, 0, '2026-04-01 10:00:00', '2026-04-01 10:00:00', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (6, 3, 4, 33, 1, 0, '11.50', '11.50', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (7, 3, 1, 29, 1, 0, '10', '10', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (7, 3, 2, 33, 1, 0, 'view', 'view', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (7, 3, 3, 33, 1, 0, '2026-03-07 10:00:00', '2026-03-07 10:00:00', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (7, 3, 4, 33, 1, 0, '10.50', '10.50', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (8, 6, 1, 45, 4, 0, 'a', 'b', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (8, 6, 2, 56, 4, 0, '2026-02-01 00:00:00', '2026-02-02 00:00:00', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (8, 6, 3, 50, 4, 0, '0.5', '3.5', false, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (9, 9, 1, 41, 4, 0, '1', '4', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (9, 9, 2, 50, 4, 0, 'ada', 'di', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (9, 9, 3, 55, 4, 0, 'bronze', 'silver', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (10, 9, 1, 29, 1, 0, '2', '2', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (10, 9, 2, 32, 1, 0, 'bob', 'bob', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (10, 9, 3, 33, 1, 0, 'gold', 'gold', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (15, 3, 1, 29, 1, 0, '12', '12', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (15, 3, 2, 33, 1, 0, 'view', 'view', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (15, 3, 3, 33, 1, 0, '2026-04-02 10:00:00', '2026-04-02 10:00:00', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (15, 3, 4, 33, 1, 0, '12.50', '12.50', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (16, 9, 1, 29, 1, 0, '5', '5', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (16, 9, 2, 32, 1, 0, 'eve', 'eve', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (16, 9, 3, 35, 1, 0, 'silver', 'silver', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (17, 11, 1, 29, 1, 0, '1', '1', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (17, 11, 2, 64, 1, 0, 'created together with its first row', 'created together with its first row', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (18, 9, 1, 29, 1, 0, '6', '6', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (18, 9, 2, 32, 1, 0, 'flo', 'flo', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (18, 9, 3, 35, 1, 0, 'bronze', 'bronze', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (19, 12, 1, 29, 1, 0, '1', '1', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (19, 12, 2, 32, 1, 0, 'one', 'one', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (19, 12, 4, 29, 1, 0, '1', '1', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (19, 12, 5, 30, 1, 0, 'x', 'x', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (19, 12, 6, 29, 1, 0, '10', '10', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (20, 12, 1, 29, 1, 0, '2', '2', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (20, 12, 2, 32, 1, 0, 'two', 'two', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (20, 12, 4, 29, 1, 0, '2', '2', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (20, 12, 5, 30, 1, 0, 'y', 'y', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (20, 12, 6, 33, 1, 0, '20', '20', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (20, 12, 8, 33, 1, 0, '2.5', '2.5', false, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (20, 12, 9, 26, 1, 0, '0', '0', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (21, 15, 1, 33, 2, 0, '1', '2', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (26, 19, 1, 35, 4, 0, '1', '4', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (26, 19, 2, 47, 4, 0, 'line 1', 'line 4', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (27, 19, 1, 29, 1, 0, '5', '5', NULL, NULL, true, true);
INSERT INTO public.ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value, contains_nan, extra_stats, min_is_exact, max_is_exact) VALUES (27, 19, 2, 35, 1, 0, 'line 5', 'line 5', NULL, NULL, true, true);


--
-- Data for Name: ducklake_file_partition_value; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (0, 3, 0, 'click');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (0, 3, 1, '2025');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (1, 3, 0, 'click');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (1, 3, 1, '2026');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (2, 3, 0, 'view');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (2, 3, 1, '2025');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (3, 3, 0, 'view');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (3, 3, 1, '2026');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (4, 3, 0, 'click');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (4, 3, 1, '2025');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (5, 3, 0, 'click');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (5, 3, 1, '3');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (6, 3, 0, 'click');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (6, 3, 1, '4');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (7, 3, 0, 'view');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (7, 3, 1, '3');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (15, 3, 0, 'view');
INSERT INTO public.ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value) VALUES (15, 3, 1, '4');


--
-- Data for Name: ducklake_file_variant_stats; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_files_scheduled_for_deletion; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_files_scheduled_for_deletion (data_file_id, path, path_is_relative, schedule_start) VALUES (11, 'shop/customers/ducklake-01a18cd6-de04-7bdf-b574-188515d34155-delete.parquet', true, '2026-10-30 12:44:14.22165+00');
INSERT INTO public.ducklake_files_scheduled_for_deletion (data_file_id, path, path_is_relative, schedule_start) VALUES (22, 'shop/log/ducklake-01a18cd6-e578-7a9e-88b6-c2253ffdee92.parquet', true, '2026-10-30 12:44:16.180527+00');
INSERT INTO public.ducklake_files_scheduled_for_deletion (data_file_id, path, path_is_relative, schedule_start) VALUES (23, 'shop/log/ducklake-01a18cd6-e582-70a7-a36a-c1c5a5e53a88.parquet', true, '2026-10-30 12:44:16.180527+00');
INSERT INTO public.ducklake_files_scheduled_for_deletion (data_file_id, path, path_is_relative, schedule_start) VALUES (24, 'shop/log/ducklake-01a18cd6-e58c-7b15-a4a6-da409002a3cc.parquet', true, '2026-10-30 12:44:16.180527+00');
INSERT INTO public.ducklake_files_scheduled_for_deletion (data_file_id, path, path_is_relative, schedule_start) VALUES (25, 'shop/log/ducklake-01a18cd6-e598-7efb-a22d-6105a7f218c0.parquet', true, '2026-10-30 12:44:16.180527+00');


--
-- Data for Name: ducklake_inlined_data_10_12; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_inlined_data_10_12 (_ducklake_row_id, _ducklake_begin_snapshot, _ducklake_end_snapshot, id, body) VALUES (1, 20, NULL, 2, '\x7365636f6e64');
INSERT INTO public.ducklake_inlined_data_10_12 (_ducklake_row_id, _ducklake_begin_snapshot, _ducklake_end_snapshot, id, body) VALUES (0, 21, NULL, 1, '\x6368616e676564');
INSERT INTO public.ducklake_inlined_data_10_12 (_ducklake_row_id, _ducklake_begin_snapshot, _ducklake_end_snapshot, id, body) VALUES (0, 20, 21, 1, '\x6669727374');
INSERT INTO public.ducklake_inlined_data_10_12 (_ducklake_row_id, _ducklake_begin_snapshot, _ducklake_end_snapshot, id, body) VALUES (2, 20, 22, 3, '\x7468697264');


--
-- Data for Name: ducklake_inlined_data_tables; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_inlined_data_tables (table_id, table_name, schema_version) VALUES (10, 'ducklake_inlined_data_10_12', 12);


--
-- Data for Name: ducklake_macro; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_macro (schema_id, macro_id, macro_name, begin_snapshot, end_snapshot) VALUES (1, 16, 'gross', 46, NULL);
INSERT INTO public.ducklake_macro (schema_id, macro_id, macro_name, begin_snapshot, end_snapshot) VALUES (1, 17, 'recent_events', 47, NULL);
INSERT INTO public.ducklake_macro (schema_id, macro_id, macro_name, begin_snapshot, end_snapshot) VALUES (1, 18, 'legacy_fee', 48, 49);


--
-- Data for Name: ducklake_macro_impl; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_macro_impl (macro_id, impl_id, dialect, sql, type) VALUES (16, 0, 'duckdb', '(net * rate)', 'scalar');
INSERT INTO public.ducklake_macro_impl (macro_id, impl_id, dialect, sql, type) VALUES (17, 0, 'duckdb', 'SELECT * FROM shop.events ORDER BY ts DESC LIMIT n', 'table');
INSERT INTO public.ducklake_macro_impl (macro_id, impl_id, dialect, sql, type) VALUES (18, 0, 'duckdb', '(x + 1)', 'scalar');


--
-- Data for Name: ducklake_macro_parameters; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_macro_parameters (macro_id, impl_id, column_id, parameter_name, parameter_type, default_value, default_value_type) VALUES (16, 0, 0, 'net', 'unknown', 'NULL', 'unknown');
INSERT INTO public.ducklake_macro_parameters (macro_id, impl_id, column_id, parameter_name, parameter_type, default_value, default_value_type) VALUES (16, 0, 1, 'rate', 'unknown', '1.19', 'decimal(3,2)');
INSERT INTO public.ducklake_macro_parameters (macro_id, impl_id, column_id, parameter_name, parameter_type, default_value, default_value_type) VALUES (17, 0, 0, 'n', 'unknown', 'NULL', 'unknown');
INSERT INTO public.ducklake_macro_parameters (macro_id, impl_id, column_id, parameter_name, parameter_type, default_value, default_value_type) VALUES (18, 0, 0, 'x', 'unknown', 'NULL', 'unknown');


--
-- Data for Name: ducklake_metadata; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_metadata (key, value, scope, scope_id) VALUES ('version', '1.1', NULL, NULL);
INSERT INTO public.ducklake_metadata (key, value, scope, scope_id) VALUES ('created_by', 'DuckDB d54cbbe3df', NULL, NULL);
INSERT INTO public.ducklake_metadata (key, value, scope, scope_id) VALUES ('data_path', '/tmp/aantje-fixture-data/', NULL, NULL);
INSERT INTO public.ducklake_metadata (key, value, scope, scope_id) VALUES ('encrypted', 'false', NULL, NULL);
INSERT INTO public.ducklake_metadata (key, value, scope, scope_id) VALUES ('data_inlining_row_limit', '10', 'table', 10);


--
-- Data for Name: ducklake_name_mapping; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ducklake_partition_column; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_partition_column (partition_id, table_id, partition_key_index, column_id, transform) VALUES (4, 3, 0, 2, 'identity');
INSERT INTO public.ducklake_partition_column (partition_id, table_id, partition_key_index, column_id, transform) VALUES (4, 3, 1, 3, 'year');
INSERT INTO public.ducklake_partition_column (partition_id, table_id, partition_key_index, column_id, transform) VALUES (5, 3, 0, 2, 'identity');
INSERT INTO public.ducklake_partition_column (partition_id, table_id, partition_key_index, column_id, transform) VALUES (5, 3, 1, 3, 'month');


--
-- Data for Name: ducklake_partition_info; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_partition_info (partition_id, table_id, begin_snapshot, end_snapshot) VALUES (4, 3, 5, 9);
INSERT INTO public.ducklake_partition_info (partition_id, table_id, begin_snapshot, end_snapshot) VALUES (5, 3, 9, NULL);


--
-- Data for Name: ducklake_schema; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_schema (schema_id, schema_uuid, begin_snapshot, end_snapshot, schema_name, path, path_is_relative, parent_schema_id) VALUES (0, '01a18cd6-da8d-7f55-be9e-ee5921ba41da', 0, NULL, 'main', 'main/', true, NULL);
INSERT INTO public.ducklake_schema (schema_id, schema_uuid, begin_snapshot, end_snapshot, schema_name, path, path_is_relative, parent_schema_id) VALUES (1, '01a18cd6-db2f-76b6-b28a-9ed7e1ae2a63', 1, NULL, 'shop', 'shop/', true, NULL);
INSERT INTO public.ducklake_schema (schema_id, schema_uuid, begin_snapshot, end_snapshot, schema_name, path, path_is_relative, parent_schema_id) VALUES (2, '01a18cd6-db4d-7441-8a64-7baf3075da65', 2, 3, 'scratch', 'scratch/', true, NULL);


--
-- Data for Name: ducklake_schema_versions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (4, 4, 3);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (5, 5, 3);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (9, 6, 3);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (11, 7, 6);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (15, 10, 9);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (19, 11, 10);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (24, 13, 11);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (26, 14, 12);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (28, 15, 12);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (29, 16, 12);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (30, 17, 12);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (31, 18, 12);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (32, 19, 12);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (33, 20, 12);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (34, 21, 12);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (35, 22, 12);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (43, 29, 15);
INSERT INTO public.ducklake_schema_versions (begin_snapshot, schema_version, table_id) VALUES (50, 35, 19);


--
-- Data for Name: ducklake_snapshot; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (0, '2026-10-30 12:44:13.292474+00', 0, 1, 0);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (1, '2026-10-30 12:44:13.486198+00', 1, 2, 0);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (2, '2026-10-30 12:44:13.492195+00', 2, 3, 0);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (3, '2026-10-30 12:44:13.519986+00', 3, 3, 0);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (4, '2026-10-30 12:44:13.547533+00', 4, 4, 0);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (5, '2026-10-30 12:44:13.609452+00', 5, 5, 0);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (6, '2026-10-30 12:44:13.665443+00', 5, 5, 3);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (7, '2026-10-30 12:44:13.706093+00', 5, 5, 4);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (8, '2026-10-30 12:44:13.717606+00', 5, 5, 5);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (9, '2026-10-30 12:44:13.731155+00', 6, 6, 5);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (10, '2026-10-30 12:44:13.769303+00', 6, 6, 8);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (11, '2026-10-30 12:44:13.825882+00', 7, 7, 8);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (12, '2026-10-30 12:44:13.870367+00', 8, 8, 8);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (13, '2026-10-30 12:44:13.940039+00', 8, 8, 9);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (14, '2026-10-30 12:44:13.994156+00', 9, 9, 9);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (15, '2026-10-30 12:44:14.03835+00', 10, 10, 9);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (16, '2026-10-30 12:44:14.132902+00', 10, 10, 10);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (17, '2026-10-30 12:44:14.190523+00', 10, 10, 12);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (18, '2026-10-30 12:44:14.22165+00', 10, 10, 13);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (19, '2026-10-30 12:44:14.248776+00', 11, 11, 13);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (20, '2026-10-30 12:44:14.355795+00', 12, 11, 14);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (21, '2026-10-30 12:44:14.376457+00', 12, 11, 15);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (22, '2026-10-30 12:44:14.477039+00', 12, 11, 15);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (23, '2026-10-30 12:44:14.502395+00', 12, 11, 17);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (24, '2026-10-30 12:44:14.525352+00', 13, 12, 18);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (25, '2026-10-30 12:44:14.583021+00', 13, 12, 19);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (26, '2026-10-30 12:44:14.643+00', 14, 13, 19);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (27, '2026-10-30 12:44:14.692967+00', 14, 13, 20);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (28, '2026-10-30 12:44:14.748881+00', 15, 13, 20);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (29, '2026-10-30 12:44:14.798596+00', 16, 13, 20);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (30, '2026-10-30 12:44:14.887527+00', 17, 13, 20);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (31, '2026-10-30 12:44:14.974011+00', 18, 13, 20);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (32, '2026-10-30 12:44:15.051616+00', 19, 13, 20);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (33, '2026-10-30 12:44:15.126603+00', 20, 13, 20);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (34, '2026-10-30 12:44:15.211984+00', 21, 13, 20);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (35, '2026-10-30 12:44:15.275761+00', 22, 13, 20);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (36, '2026-10-30 12:44:15.355799+00', 22, 13, 21);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (37, '2026-10-30 12:44:15.413398+00', 23, 13, 21);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (38, '2026-10-30 12:44:15.444572+00', 24, 13, 21);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (39, '2026-10-30 12:44:15.512748+00', 25, 14, 21);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (40, '2026-10-30 12:44:15.577596+00', 26, 14, 21);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (41, '2026-10-30 12:44:15.645835+00', 27, 15, 21);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (42, '2026-10-30 12:44:15.709678+00', 28, 15, 21);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (43, '2026-10-30 12:44:15.742711+00', 29, 16, 21);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (44, '2026-10-30 12:44:15.809665+00', 29, 16, 22);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (45, '2026-10-30 12:44:15.849966+00', 30, 16, 22);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (46, '2026-10-30 12:44:15.854279+00', 31, 17, 22);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (47, '2026-10-30 12:44:15.88766+00', 32, 18, 22);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (48, '2026-10-30 12:44:15.923377+00', 33, 19, 22);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (49, '2026-10-30 12:44:15.962511+00', 34, 19, 22);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (50, '2026-10-30 12:44:16.009656+00', 35, 20, 22);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (51, '2026-10-30 12:44:16.087436+00', 35, 20, 23);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (52, '2026-10-30 12:44:16.1282+00', 35, 20, 24);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (53, '2026-10-30 12:44:16.138905+00', 35, 20, 25);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (54, '2026-10-30 12:44:16.149956+00', 35, 20, 26);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (55, '2026-10-30 12:44:16.180527+00', 35, 20, 27);
INSERT INTO public.ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (56, '2026-10-30 12:44:16.188396+00', 35, 20, 28);


--
-- Data for Name: ducklake_snapshot_changes; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (0, 'created_schema:"main"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (1, 'created_schema:"shop"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (2, 'created_schema:"scratch"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (3, 'dropped_schema:2', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (4, 'created_table:"shop"."events"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (5, 'altered_table:3', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (6, 'inserted_into_table:3', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (7, 'inserted_into_table:3', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (8, 'inserted_into_table:3', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (9, 'altered_table:3', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (10, 'inserted_into_table:3', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (11, 'created_table:"shop"."readings"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (12, 'altered_table:6', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (13, 'inserted_into_table:6', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (14, 'altered_table:6', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (15, 'created_table:"shop"."customers"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (16, 'inserted_into_table:9', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (17, 'inserted_into_table:9,deleted_from_table:9', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (18, 'deleted_from_table:9', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (19, 'created_table:"shop"."notes"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (20, 'inlined_insert:10', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (21, 'inlined_insert:10,inlined_delete:10', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (22, 'inlined_delete:10', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (23, 'inserted_into_table:3,inserted_into_table:9', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (24, 'created_table:"shop"."audit",inserted_into_table:11', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (25, 'inserted_into_table:9', 'tillmann', 'Nightly import', '{"source":"nightly","rows":1}');
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (26, 'created_table:"main"."evolving"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (27, 'inserted_into_table:12', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (28, 'altered_table:12', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (29, 'altered_table:12', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (30, 'altered_table:12', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (31, 'altered_table:12', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (32, 'altered_table:12', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (33, 'altered_table:12', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (34, 'altered_table:12', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (35, 'created_table:"main"."evolved"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (36, 'inserted_into_table:12', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (37, 'altered_table:9', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (38, 'altered_table:9', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (39, 'created_view:"shop"."big_events"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (40, 'altered_view:13', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (41, 'created_view:"shop"."tmp_view"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (42, 'dropped_view:14', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (43, 'created_table:"shop"."old_stuff"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (44, 'inserted_into_table:15', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (45, 'dropped_table:15', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (46, 'created_scalar_macro:"shop"."gross"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (47, 'created_table_macro:"shop"."recent_events"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (48, 'created_scalar_macro:"shop"."legacy_fee"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (49, 'dropped_scalar_macro:18', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (50, 'created_table:"shop"."log"', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (51, 'inserted_into_table:19', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (52, 'inserted_into_table:19', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (53, 'inserted_into_table:19', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (54, 'inserted_into_table:19', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (55, 'merge_adjacent:19', NULL, NULL, NULL);
INSERT INTO public.ducklake_snapshot_changes (snapshot_id, changes_made, author, commit_message, commit_extra_info) VALUES (56, 'inserted_into_table:19', NULL, NULL, NULL);


--
-- Data for Name: ducklake_sort_expression; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_sort_expression (sort_id, table_id, sort_key_index, expression, dialect, sort_direction, null_order) VALUES (7, 6, 0, 'sensor', 'duckdb', 'ASC', 'NULLS_LAST');
INSERT INTO public.ducklake_sort_expression (sort_id, table_id, sort_key_index, expression, dialect, sort_direction, null_order) VALUES (7, 6, 1, 'taken_at', 'duckdb', 'DESC', 'NULLS_LAST');
INSERT INTO public.ducklake_sort_expression (sort_id, table_id, sort_key_index, expression, dialect, sort_direction, null_order) VALUES (8, 6, 0, '"value"', 'duckdb', 'DESC', 'NULLS_FIRST');


--
-- Data for Name: ducklake_sort_info; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_sort_info (sort_id, table_id, begin_snapshot, end_snapshot) VALUES (7, 6, 12, 14);
INSERT INTO public.ducklake_sort_info (sort_id, table_id, begin_snapshot, end_snapshot) VALUES (8, 6, 14, NULL);


--
-- Data for Name: ducklake_table; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_table (table_id, table_uuid, begin_snapshot, end_snapshot, schema_id, table_name, path, path_is_relative) VALUES (3, '01a18cd6-db85-7704-84e0-9306f44d9b66', 4, NULL, 1, 'events', 'events/', true);
INSERT INTO public.ducklake_table (table_id, table_uuid, begin_snapshot, end_snapshot, schema_id, table_name, path, path_is_relative) VALUES (6, '01a18cd6-dc85-7339-b019-1f5c05360e93', 11, NULL, 1, 'readings', 'readings/', true);
INSERT INTO public.ducklake_table (table_id, table_uuid, begin_snapshot, end_snapshot, schema_id, table_name, path, path_is_relative) VALUES (9, '01a18cd6-dd7f-7975-9906-602a111e99b8', 15, NULL, 1, 'customers', 'customers/', true);
INSERT INTO public.ducklake_table (table_id, table_uuid, begin_snapshot, end_snapshot, schema_id, table_name, path, path_is_relative) VALUES (10, '01a18cd6-de2b-792d-bb5c-4bf014304863', 19, NULL, 1, 'notes', 'notes/', true);
INSERT INTO public.ducklake_table (table_id, table_uuid, begin_snapshot, end_snapshot, schema_id, table_name, path, path_is_relative) VALUES (11, '01a18cd6-df40-78e8-a61d-a1004c398559', 24, NULL, 1, 'audit', 'audit/', true);
INSERT INTO public.ducklake_table (table_id, table_uuid, begin_snapshot, end_snapshot, schema_id, table_name, path, path_is_relative) VALUES (12, '01a18cd6-dfb5-7e88-8dfd-137f62fa0d36', 26, 35, 0, 'evolving', 'evolving/', true);
INSERT INTO public.ducklake_table (table_id, table_uuid, begin_snapshot, end_snapshot, schema_id, table_name, path, path_is_relative) VALUES (12, '01a18cd6-dfb5-7e88-8dfd-137f62fa0d36', 35, NULL, 0, 'evolved', 'evolving/', true);
INSERT INTO public.ducklake_table (table_id, table_uuid, begin_snapshot, end_snapshot, schema_id, table_name, path, path_is_relative) VALUES (15, '01a18cd6-e420-78a4-bc31-96bb49e7bf45', 43, 45, 1, 'old_stuff', 'old_stuff/', true);
INSERT INTO public.ducklake_table (table_id, table_uuid, begin_snapshot, end_snapshot, schema_id, table_name, path, path_is_relative) VALUES (19, '01a18cd6-e531-7627-ba70-20a73dbe81f5', 50, NULL, 1, 'log', 'log/', true);


--
-- Data for Name: ducklake_table_column_stats; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (6, 1, false, NULL, 'a', 'b', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (6, 2, false, NULL, '2026-02-01 00:00:00', '2026-02-02 00:00:00', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (6, 3, false, false, '0.5', '3.5', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (10, 1, false, NULL, '1', '3', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (10, 2, false, NULL, 'changed', 'third', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (3, 1, false, NULL, '1', '139', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (3, 2, false, NULL, 'click', 'view', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (3, 3, false, NULL, '2025-03-01 10:00:00', '2026-04-02 10:00:00', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (3, 4, false, NULL, '0.00', '58.50', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (11, 1, false, NULL, '1', '1', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (11, 2, false, NULL, 'created together with its first row', 'created together with its first row', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (9, 1, false, NULL, '1', '6', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (9, 2, false, NULL, 'ada', 'flo', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (9, 3, false, NULL, 'bronze', 'silver', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (12, 7, true, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (12, 1, false, NULL, '1', '2', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (12, 2, false, NULL, 'one', 'two', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (12, 4, false, NULL, '1', '2', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (12, 5, false, NULL, 'x', 'y', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (12, 6, false, NULL, '10', '20', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (12, 8, true, NULL, '2.5', '2.5', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (12, 9, false, NULL, 'false', 'false', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (15, 1, false, NULL, '1', '2', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (19, 1, false, NULL, '1', '5', NULL, true, true);
INSERT INTO public.ducklake_table_column_stats (table_id, column_id, contains_null, contains_nan, min_value, max_value, extra_stats, min_is_exact, max_is_exact) VALUES (19, 2, false, NULL, 'line 1', 'line 5', NULL, true, true);


--
-- Data for Name: ducklake_table_stats; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_table_stats (table_id, record_count, next_row_id, file_size_bytes) VALUES (6, 4, 4, 545);
INSERT INTO public.ducklake_table_stats (table_id, record_count, next_row_id, file_size_bytes) VALUES (10, 4, 3, 0);
INSERT INTO public.ducklake_table_stats (table_id, record_count, next_row_id, file_size_bytes) VALUES (3, 52, 52, 6349);
INSERT INTO public.ducklake_table_stats (table_id, record_count, next_row_id, file_size_bytes) VALUES (11, 1, 1, 480);
INSERT INTO public.ducklake_table_stats (table_id, record_count, next_row_id, file_size_bytes) VALUES (9, 7, 7, 2006);
INSERT INTO public.ducklake_table_stats (table_id, record_count, next_row_id, file_size_bytes) VALUES (12, 2, 2, 1562);
INSERT INTO public.ducklake_table_stats (table_id, record_count, next_row_id, file_size_bytes) VALUES (15, 2, 2, 207);
INSERT INTO public.ducklake_table_stats (table_id, record_count, next_row_id, file_size_bytes) VALUES (19, 5, 5, 1081);


--
-- Data for Name: ducklake_tag; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_tag (object_id, begin_snapshot, end_snapshot, key, value) VALUES (9, 37, NULL, 'comment', 'Customers of the shop');
INSERT INTO public.ducklake_tag (object_id, begin_snapshot, end_snapshot, key, value) VALUES (13, 40, NULL, 'comment', 'Events above 10');


--
-- Data for Name: ducklake_view; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.ducklake_view (view_id, view_uuid, begin_snapshot, end_snapshot, schema_id, view_name, dialect, sql, column_aliases) VALUES (13, 'd5b70834-21cf-46a1-95ba-2e8ecb2d084a', 39, NULL, 1, 'big_events', 'duckdb', 'SELECT * FROM shop.events WHERE (amount > 10)', '');
INSERT INTO public.ducklake_view (view_id, view_uuid, begin_snapshot, end_snapshot, schema_id, view_name, dialect, sql, column_aliases) VALUES (14, '35b391ac-fa2f-4e87-87dc-d107a8254976', 41, 42, 1, 'tmp_view', 'duckdb', 'SELECT 1 AS x', '');


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


